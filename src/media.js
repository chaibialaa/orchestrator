import { createHash } from 'node:crypto'
import { extname } from 'node:path'
import sharp from 'sharp'

const digest=buffer=>createHash('sha256').update(buffer).digest('hex')
const imageExtensions=new Set(['.png','.jpg','.jpeg','.webp','.tif','.tiff','.avif'])

export async function optimizeImageTransport(buffer,{path='',mime='',maxPixels=Number(process.env.ORCHESTRATOR_IMAGE_MAX_PX)||1920,quality=Number(process.env.ORCHESTRATOR_IMAGE_QUALITY)||82}={}){
  const extension=extname(path).toLowerCase(),isImage=String(mime).startsWith('image/')||imageExtensions.has(extension),original={buffer,mime:mime||'application/octet-stream',extension,bytes:buffer.length,sha256:digest(buffer),optimized:false}
  if(!isImage||extension==='.gif'||String(mime).includes('gif'))return original
  try{
    const image=sharp(buffer,{failOn:'none'}).rotate(),metadata=await image.metadata(),largest=Math.max(metadata.width||0,metadata.height||0),resize=largest>maxPixels?{width:maxPixels,height:maxPixels,fit:'inside',withoutEnlargement:true}:undefined,output=await image.resize(resize).webp({quality:Math.max(40,Math.min(95,quality)),effort:4}).toBuffer()
    if(output.length>=buffer.length)return original
    return{buffer:output,mime:'image/webp',extension:'.webp',bytes:output.length,sha256:digest(output),optimized:true,source_bytes:buffer.length,source_sha256:original.sha256,width:metadata.width||null,height:metadata.height||null}
  }catch{return original}
}
