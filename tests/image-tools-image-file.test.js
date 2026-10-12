import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectImageFile, parseImageHeader } from '../public/assets/components/image-tools/image-file.js';

function pngHeader(width,height) {
  const bytes=new Uint8Array(24); bytes.set([137,80,78,71,13,10,26,10],0); bytes.set([73,72,68,82],12);
  new DataView(bytes.buffer).setUint32(16,width); new DataView(bytes.buffer).setUint32(20,height); return bytes;
}
function file(bytes,type='image/png') {
  return { size:bytes.length,type,slice(start,end){const data=bytes.slice(start,end);return {arrayBuffer:async()=>data.buffer};} };
}

test('image preflight reads PNG dimensions before any full decode',async()=>{
  assert.deepEqual(parseImageHeader(pngHeader(2048,1024)),{type:'image/png',width:2048,height:1024});
  assert.deepEqual(await inspectImageFile(file(pngHeader(32,24))),{type:'image/png',width:32,height:24});
  await assert.rejects(inspectImageFile(file(pngHeader(100000,100000))),/3200 万像素/);
  await assert.rejects(inspectImageFile(file(pngHeader(32,24),'image/svg+xml')),/类型与图片内容不一致/);
});

test('JPEG dimensions are read from a bounded SOF header',()=>{
  const bytes=Uint8Array.from([0xff,0xd8,0xff,0xc0,0,17,8,0,16,0,32,3,1,0x11,0,2,0x11,0,3,0x11,0]);
  assert.deepEqual(parseImageHeader(bytes),{type:'image/jpeg',height:16,width:32});
  assert.throws(()=>parseImageHeader(Uint8Array.from([0xff,0xd8,0xff,0xda])),/无法识别/);
});

test('WebP variants parse dimensions and animated WebP is identified before bitmap creation',async()=>{
  const extended=new Uint8Array(30); extended.set([...Buffer.from('RIFF')],0); extended.set([...Buffer.from('WEBPVP8X')],8); extended[20]=2; extended[24]=31; extended[27]=23;
  assert.deepEqual(parseImageHeader(extended),{type:'image/webp',animated:true,width:32,height:24});
  await assert.rejects(inspectImageFile(file(extended,'image/webp')),/动态 WebP/);
  const lossless=new Uint8Array(25); lossless.set([...Buffer.from('RIFF')],0); lossless.set([...Buffer.from('WEBPVP8L')],8); lossless[20]=0x2f; lossless[21]=31; lossless[23]=5;
  assert.deepEqual(parseImageHeader(lossless),{type:'image/webp',width:32,height:21});
});

test('empty, oversized and unknown image files fail before decoding',async()=>{
  await assert.rejects(inspectImageFile(file(new Uint8Array(0))),/为空/);
  await assert.rejects(inspectImageFile({size:10*1024*1024+1,type:'image/png'}),/10 MB/);
  await assert.rejects(inspectImageFile(file(new Uint8Array(40))),/无法识别/);
});
