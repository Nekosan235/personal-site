#!/usr/bin/env python3
"""Push one Linux cloud VM's CPU, memory, root disk, and uptime to personal-site."""

import argparse
import hashlib
import hmac
import json
import os
import platform
import re
import secrets
import sys
import time
import urllib.error
import urllib.request

GIB = 1024 ** 3
DEVICE_ID = re.compile(r"^[A-Za-z0-9_.:-]{1,64}$")


def as_gib(value):
    return round(value / GIB, 2)


def read_meminfo(path="/proc/meminfo"):
    values = {}
    with open(path, "r", encoding="utf-8") as handle:
        for line in handle:
            key, _, rest = line.partition(":")
            parts = rest.strip().split()
            if len(parts) >= 2 and parts[1] == "kB":
                values[key] = int(parts[0])
    total = values.get("MemTotal")
    available = values.get("MemAvailable")
    if total is None or available is None or total <= 0 or available < 0 or available > total:
        raise RuntimeError("invalid meminfo")
    total_bytes = total * 1024
    available_bytes = available * 1024
    return {
        "used": as_gib(total_bytes - available_bytes),
        "total": as_gib(total_bytes),
        "available": as_gib(available_bytes),
        "reserved": None,
        "unit": "GiB",
    }


def read_cpu(path="/proc/stat"):
    with open(path, "r", encoding="utf-8") as handle:
        for line in handle:
            if line.startswith("cpu "):
                values = [int(value) for value in line.split()[1:9]]
                idle = values[3] + values[4]
                return {"idle": idle, "total": sum(values)}
    raise RuntimeError("missing aggregate cpu counters")


def cpu_percent(previous, current):
    if not previous:
        return None
    total_delta = current["total"] - previous["total"]
    idle_delta = current["idle"] - previous["idle"]
    if total_delta <= 0 or idle_delta < 0:
        return None
    value = ((total_delta - idle_delta) / total_delta) * 100
    return round(min(100.0, max(0.0, value)), 1)


def volume_metric(path):
    stats = os.statvfs(path)
    stat_info = os.stat(path)
    block_size = stats.f_frsize or stats.f_bsize
    total = stats.f_blocks * block_size
    free = stats.f_bfree * block_size
    available = stats.f_bavail * block_size
    if total <= 0 or free < 0 or available < 0 or available > free:
        raise RuntimeError(f"invalid statvfs values for {path}")
    return {
        "path": path,
        "device": str(stat_info.st_dev),
        "used": as_gib(total - free),
        "total": as_gib(total),
        "available": as_gib(available),
        "reserved": as_gib(free - available),
        "unit": "GiB",
    }


def read_volumes(paths, skip_devices):
    seen_devices = set(skip_devices)
    volumes = []
    missing = []
    for raw_path in paths:
        path = raw_path.strip()
        if not path or path == "/":
            continue
        if not os.path.isdir(path):
            missing.append({"path": path, "error": "not_directory"})
            continue
        try:
            metric = volume_metric(path)
        except OSError as error:
            print(f"skip volume {path}: {error}", file=sys.stderr)
            missing.append({"path": path, "error": error.__class__.__name__})
            continue
        if metric["device"] in seen_devices:
            continue
        seen_devices.add(metric["device"])
        volumes.append(metric)
    return volumes, missing


def read_disk(extra_paths):
    root = volume_metric("/")
    volumes, missing = read_volumes(extra_paths, {root["device"]})
    disk = {
        "used": root["used"],
        "total": root["total"],
        "available": root["available"],
        "reserved": root["reserved"],
        "unit": "GiB",
        "volumes": volumes,
        "missingVolumes": missing,
        "partial": bool(missing),
    }
    if missing:
        disk["error"] = {"code": "partial_volumes", "message": "Some configured volumes were unavailable"}
    return disk


def load_average():
    try:
        return [round(value, 2) for value in os.getloadavg()]
    except OSError:
        return None


def uptime_seconds():
    try:
        with open("/proc/uptime", "r", encoding="utf-8") as handle:
            return int(float(handle.read().split()[0]))
    except (OSError, ValueError, IndexError):
        return int(time.monotonic())


def build_report(args, previous_cpu):
    current_cpu = read_cpu()
    report = {
        "deviceId": args.device_id,
        "sampledAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "server": {
            "id": args.device_id,
            "name": args.name,
            "host": args.ip,
            "ip": args.ip,
            "region": args.region,
            "os": f"{platform.system()} {platform.release()}",
            "vcpu": os.cpu_count(),
            "uptimeSeconds": uptime_seconds(),
            "cpuPercent": cpu_percent(previous_cpu, current_cpu),
            "loadAverage": load_average(),
        },
        "metrics": {
            "memory": read_meminfo(),
            "disk": read_disk(args.volumes),
        },
    }
    return report, current_cpu


def sign(secret, device_id, timestamp, nonce, body):
    digest = hashlib.sha256(body).hexdigest()
    message = f"{device_id}.{timestamp}.{nonce}.{digest}".encode("utf-8")
    return "sha256=" + hmac.new(secret.encode("utf-8"), message, hashlib.sha256).hexdigest()


def send_report(args, report):
    body = json.dumps(report, separators=(",", ":"), sort_keys=True).encode("utf-8")
    timestamp = str(int(time.time()))
    nonce = secrets.token_urlsafe(18)
    signature = sign(args.secret, args.device_id, timestamp, nonce, body)
    request = urllib.request.Request(
        args.endpoint,
        data=body,
        headers={
            "Content-Type": "application/json",
            "User-Agent": "personal-site-cloud-monitor/1",
            "X-Monitor-Device-Id": args.device_id,
            "X-Monitor-Timestamp": timestamp,
            "X-Monitor-Nonce": nonce,
            "X-Monitor-Signature": signature,
        },
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=args.timeout) as response:
        response.read()
        if response.status != 200:
            raise RuntimeError(f"unexpected status {response.status}")


def env(name, default=""):
    return os.environ.get(name, default)


def parse_args():
    parser = argparse.ArgumentParser(description="Push Linux cloud VM metrics to personal-site over HTTPS.")
    parser.add_argument("--endpoint", default=env("CLOUD_MONITOR_ENDPOINT"), help="HTTPS report URL ending in /api/monitor/remote/report")
    parser.add_argument("--secret", default=env("CLOUD_MONITOR_SECRET"), help="shared or per-device HMAC secret")
    parser.add_argument("--device-id", default=env("CLOUD_DEVICE_ID"))
    parser.add_argument("--name", default=env("CLOUD_DEVICE_NAME"))
    parser.add_argument("--region", default=env("CLOUD_DEVICE_REGION"))
    parser.add_argument("--ip", default=env("CLOUD_DEVICE_IP"))
    parser.add_argument("--interval", type=int, default=int(env("CLOUD_MONITOR_INTERVAL", "15")))
    parser.add_argument("--timeout", type=int, default=int(env("CLOUD_MONITOR_TIMEOUT", "10")))
    parser.add_argument("--volume", dest="volumes", action="append")
    parser.add_argument("--once", action="store_true", help="send one report and exit")
    args = parser.parse_args()
    if args.volumes is None:
        configured = env("CLOUD_MONITOR_PATHS", "")
        args.volumes = [item.strip() for item in configured.split(",") if item.strip()]
    if not args.endpoint or not args.endpoint.startswith("https://"):
        raise SystemExit("CLOUD_MONITOR_ENDPOINT must be an https:// URL")
    if not args.secret or len(args.secret) < 32:
        raise SystemExit("CLOUD_MONITOR_SECRET must be at least 32 characters")
    if not args.device_id or not DEVICE_ID.fullmatch(args.device_id):
        raise SystemExit("CLOUD_DEVICE_ID must match [A-Za-z0-9_.:-]{1,64}")
    if not args.name:
        args.name = args.device_id
    if args.interval < 5:
        raise SystemExit("interval must be at least 5 seconds")
    return args


def main():
    args = parse_args()
    previous_cpu = None
    while True:
        started = time.monotonic()
        next_cpu = None
        try:
            report, next_cpu = build_report(args, previous_cpu)
            send_report(args, report)
            previous_cpu = next_cpu
            if args.once:
                return 0
        except (OSError, RuntimeError, urllib.error.URLError) as error:
            print(f"cloud-monitor error: {error}", file=sys.stderr)
            if next_cpu is not None:
                previous_cpu = next_cpu
            if args.once:
                return 1
        elapsed = time.monotonic() - started
        time.sleep(max(1, args.interval - elapsed))


if __name__ == "__main__":
    raise SystemExit(main())
