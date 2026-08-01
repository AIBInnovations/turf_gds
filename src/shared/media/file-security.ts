import { AppError } from '../errors/app-error.js';

export function inspectUploadedFile(buffer:Buffer,claimedMime:string,allowed:string[]):string{
 if(buffer.length===0)throw invalid('EMPTY_UPLOAD','Uploaded file is empty');
 const detected=detectMime(buffer);
 if(!detected||!allowed.includes(detected))throw invalid('UNSUPPORTED_FILE_CONTENT','The uploaded bytes are not an allowed file type');
 if(detected!==claimedMime.toLowerCase())throw invalid('FILE_CONTENT_MISMATCH','The uploaded file content does not match its declared MIME type');
 if(buffer.includes(Buffer.from('EICAR-STANDARD-ANTIVIRUS-TEST-FILE','ascii')))throw invalid('MALWARE_DETECTED','The uploaded file failed malware screening');
 return detected;
}
export function detectMime(b:Buffer):string|null{if(b.length>=4&&b[0]===0xff&&b[1]===0xd8&&b[2]===0xff)return'image/jpeg';if(b.length>=8&&b.subarray(0,8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a])))return'image/png';if(b.length>=5&&b.subarray(0,5).toString('ascii')==='%PDF-')return'application/pdf';if(b.length>=12&&b.subarray(0,4).toString('ascii')==='RIFF'&&b.subarray(8,12).toString('ascii')==='WEBP')return'image/webp';return null;}
function invalid(code:string,message:string){return new AppError({code,message,statusCode:400});}
