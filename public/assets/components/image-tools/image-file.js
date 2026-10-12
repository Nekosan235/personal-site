const SOF = new Set([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf]);
const ascii = (bytes, start, value) => [...value].every((char, index) => bytes[start + index] === char.charCodeAt(0));

export function parseImageHeader(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length >= 24 && bytes[0] === 137 && ascii(bytes, 1, 'PNG\r\n\x1a\n') && ascii(bytes, 12, 'IHDR')) {
    return { type: 'image/png', width: ((bytes[16]<<24)|(bytes[17]<<16)|(bytes[18]<<8)|bytes[19])>>>0, height: ((bytes[20]<<24)|(bytes[21]<<16)|(bytes[22]<<8)|bytes[23])>>>0 };
  }
  if (bytes.length >= 20 && ascii(bytes,0,'RIFF') && ascii(bytes,8,'WEBP')) {
    if (bytes.length >= 30 && ascii(bytes,12,'VP8X')) return { type:'image/webp', animated:Boolean(bytes[20]&2), width:1+bytes[24]+(bytes[25]<<8)+(bytes[26]<<16), height:1+bytes[27]+(bytes[28]<<8)+(bytes[29]<<16) };
    if (bytes.length >= 30 && ascii(bytes,12,'VP8 ') && bytes[23]===0x9d && bytes[24]===1 && bytes[25]===0x2a) {
      return { type:'image/webp', width:((bytes[27]&0x3f)<<8)|bytes[26], height:((bytes[29]&0x3f)<<8)|bytes[28] };
    }
    if (bytes.length >= 25 && ascii(bytes,12,'VP8L') && bytes[20]===0x2f) {
      return { type:'image/webp', width:1+bytes[21]+((bytes[22]&0x3f)<<8), height:1+(bytes[22]>>6)+(bytes[23]<<2)+((bytes[24]&0xf)<<10) };
    }
  }
  if (bytes[0]===0xff && bytes[1]===0xd8) {
    let offset=2;
    while(offset+3<bytes.length) {
      if(bytes[offset++]!==0xff) continue;
      while(bytes[offset]===0xff) offset++;
      const marker=bytes[offset++];
      if(marker===0xd9||marker===0xda) break;
      if(marker===0x01||(marker>=0xd0&&marker<=0xd7)) continue;
      const length=(bytes[offset]<<8)|bytes[offset+1];
      if(length<2||offset+length>bytes.length) break;
      if(SOF.has(marker)&&length>=7) return { type:'image/jpeg', height:(bytes[offset+3]<<8)|bytes[offset+4], width:(bytes[offset+5]<<8)|bytes[offset+6] };
      offset+=length;
    }
  }
  throw new Error('无法识别图片格式，请使用静态 PNG、JPEG 或 WebP。');
}

export async function inspectImageFile(file, { maxBytes=10*1024*1024, maxPixels=32_000_000, maxHeaderBytes=1024*1024 }={}) {
  if(!file||!Number.isSafeInteger(file.size)||file.size<1) throw new Error('图片文件为空。');
  if(file.size>maxBytes) throw new Error('图片不能超过 10 MB。');
  const header=parseImageHeader(await file.slice(0,Math.min(file.size,maxHeaderBytes)).arrayBuffer());
  if(header.animated) throw new Error('检测到动态 WebP。请转换为单帧图片后再编辑。');
  if(!header.width||!header.height||header.width*header.height>maxPixels) throw new Error('图片原始尺寸过大，无法安全解码；请先缩小到 3200 万像素以内。');
  const declared=file.type?.toLowerCase();
  if(declared&&declared!=='application/octet-stream'&&declared!==header.type&&!(declared==='image/jpg'&&header.type==='image/jpeg')) throw new Error('文件类型与图片内容不一致。');
  return header;
}
