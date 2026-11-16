import { mountDoorBar } from '../lib/doorbar.js';
const $=id=>document.getElementById(id);
const model=$('model'),mirror=$('mirror');
const API='/api/slp-videos';
let clips=[],index=0,camera=null,microphone=null,recorder=null,savePromise=null;
const CAMERA_KEY='era.slp-videos.camera.v1';
let cameraPreference={enabled:false,deviceId:''};
try{const saved=JSON.parse(localStorage.getItem(CAMERA_KEY));if(saved&&typeof saved.enabled==='boolean'&&typeof saved.deviceId==='string')cameraPreference=saved;}catch{}
let selectedCameraId=cameraPreference.deviceId,selectedCameraLabel=typeof cameraPreference.deviceLabel==='string'?cameraPreference.deviceLabel:'';
function saveCameraPreference(enabled){cameraPreference={enabled,deviceId:selectedCameraId,deviceLabel:selectedCameraLabel};try{localStorage.setItem(CAMERA_KEY,JSON.stringify(cameraPreference));}catch{}}
let wanted=cameraPreference.enabled,paused=false,gone=false,generation=0,acquiring=false,recordStarting=false;
let ready=false,refreshing=false,recordTimer=null,refreshTimer=null,volume=.45;
const locked=()=>window.AppLock?.isLocked()||false;
const active=()=>!gone&&!paused&&!locked()&&document.visibilityState==='visible';
async function api(url,options={}) {
 const response=await fetch(API+url,{cache:'no-store',...options});
 let result;try{result=await response.json();}catch{throw Error('The hub did not finish this request.');}
 if(!response.ok)throw Error(result.error||'Could not access local videos.');return result;
}
function controls(){
 for(const id of ['previous','play','replay','next']){
  const b=$(id);b.disabled=!ready||!active()||!clips.length||(['previous','next'].includes(id)&&clips.length<2);
  b.toggleAttribute('data-dwell-disabled',b.disabled);
 }
 const action=model.paused?'Play':'Pause';
 if($('playLabel').textContent!==action)$('playLabel').textContent=action;
 $('play').setAttribute('aria-label',action);$('play').title=action;$('play').dataset.dwellSay=action;
 $('playIcon').toggleAttribute('hidden',!model.paused);$('pauseIcon').toggleAttribute('hidden',model.paused);
 $('record').disabled=!camera||!!recorder||!!savePromise||recordStarting||!active();
 $('stopRecord').disabled=!recorder;
 $('camera').disabled=acquiring;
 $('camera').textContent=camera?'Stop camera':'Start camera';
 $('cameraSelect').disabled=acquiring||!!recorder||recordStarting;
 $('recordingBadge').hidden=!recorder;
}
function choose(next){
 if(!active()||!clips.length)return;
 model.pause();index=(next+clips.length)%clips.length;
 model.src=clips[index].url;model.volume=volume;
 $('clipTitle').textContent=clips[index].title;
 $('videoStatus').textContent=`${index+1} of ${clips.length}`;
 controls();
}
async function refresh(){
 if(refreshing)return;refreshing=true;
 try{
  const result=await api('/library'),old=clips[index]?.id,oldUrl=clips[index]?.url;
  clips=result.videos;
  $('sourceStatus').textContent=!result.available?'The selected folder is unavailable on this device.':result.source==='local'?'Using videos imported on this device.':'Reading your synced folder. New clips appear on refresh.';
  if(document.activeElement!==$('folder')&&!$('folder').dataset.edited)$('folder').value=result.source==='configured'?result.folder:'';
  $('library').replaceChildren();
  clips.forEach((clip,i)=>{const b=document.createElement('button');b.textContent=clip.title;b.onclick=()=>choose(i);$('library').append(b);});
  index=Math.max(0,clips.findIndex(c=>c.id===old));
  if(clips.length){if(clips[index].url!==oldUrl)choose(index);}
  else{model.pause();model.removeAttribute('src');model.load();$('clipTitle').textContent='Speech Mirror';$('videoStatus').textContent='No practice videos yet.';}
 }catch(e){$('sourceStatus').textContent=e.message;}
 finally{refreshing=false;controls();}
}
async function cameraOptions(){
 try{
  const selected=selectedCameraId;
  const devices=(await navigator.mediaDevices.enumerateDevices()).filter(d=>d.kind==='videoinput');
  $('cameraSelect').replaceChildren(new Option('Default front camera',''),...devices.map((d,i)=>new Option(d.label||`Camera ${i+1}`,d.deviceId)));
  if(selected&&!devices.some(d=>d.deviceId===selected))$('cameraSelect').append(new Option('Saved camera (not connected)',selected));
  $('cameraSelect').value=selected;
 }catch{}
}
async function startCamera(){
 if(!active()||camera||acquiring)return;
 if(!navigator.mediaDevices?.getUserMedia){$('cameraStatus').textContent='Camera access requires opening the hub locally on this device.';return;}
 wanted=true;acquiring=true;const token=++generation;controls();
 try{
  let deviceId=selectedCameraId;
  async function matchSavedCamera(){
   if(!deviceId||!selectedCameraLabel)return;
   const devices=await navigator.mediaDevices.enumerateDevices();
   if(devices.some(d=>d.kind==='videoinput'&&d.deviceId===deviceId))return;
   const matches=devices.filter(d=>d.kind==='videoinput'&&d.label===selectedCameraLabel);
   if(matches.length===1)deviceId=matches[0].deviceId;
  }
  await matchSavedCamera();
  if(token!==generation||!active()||!wanted)return;
  const capture=()=>navigator.mediaDevices.getUserMedia({video:deviceId?{deviceId:{exact:deviceId}}:{facingMode:'user',width:{ideal:1280},height:{ideal:720}},audio:false});
  let stream;
  try{stream=await capture();}catch(error){
   // Permission can reveal labels only after the first request; rebind solely
   // to the same uniquely named camera when the browser has rotated its ID.
   if(error.name!=='OverconstrainedError'||!selectedCameraLabel)throw error;
   const before=deviceId;await matchSavedCamera();if(before===deviceId)throw error;
   if(token!==generation||!active()||!wanted)return;
   stream=await capture();
  }
  if(token!==generation||!active()||!wanted){stream.getTracks().forEach(t=>t.stop());return;}
  camera=stream;mirror.srcObject=stream;await mirror.play();
  if(token!==generation||!active()||!wanted){stream.getTracks().forEach(t=>t.stop());return;}
  selectedCameraId=deviceId;selectedCameraLabel=stream.getVideoTracks()[0].label||selectedCameraLabel;
  saveCameraPreference(true);
  $('cameraStatus').textContent='Live mirror · camera only';
  stream.getVideoTracks()[0].onended=()=>{stopCamera(false);$('cameraStatus').textContent='Camera disconnected. Start the camera to reconnect.';};
  await cameraOptions();
 }catch(e){if(token!==generation)return;stopCamera(false);$('cameraStatus').textContent=e.name==='NotAllowedError'?'Camera access was denied. Allow the camera in the browser, then try again.':'Camera unavailable or in use. Choose the front camera and try again.';}
 finally{acquiring=false;controls();}
}
function stopCamera(user=true){
 generation++;if(user){wanted=false;saveCameraPreference(false);}
 stopRecording();
 if(camera){for(const track of camera.getTracks()){track.onended=null;track.stop();}camera=null;}
 mirror.srcObject=null;$('cameraStatus').textContent='Camera off.';controls();
}
async function startRecording(){
 if(!active()||!camera||recorder||savePromise||recordStarting)return;
 if(!window.MediaRecorder){$('recordStatus').textContent='Recording is unavailable in this browser. The live mirror still works.';return;}
 const type=['video/webm;codecs=vp8,opus','video/webm','video/mp4'].find(t=>MediaRecorder.isTypeSupported(t));
 if(!type){$('recordStatus').textContent='This browser has no supported recording format.';return;}
 recordStarting=true;const token=generation;controls();
 try{
  const audio=await navigator.mediaDevices.getUserMedia({video:false,audio:{echoCancellation:true}});
  if(token!==generation||!active()||!camera){audio.getTracks().forEach(t=>t.stop());return;}
  microphone=audio;
  const stream=new MediaStream([...camera.getVideoTracks(),...audio.getAudioTracks()]);
  const current=new MediaRecorder(stream,{mimeType:type,videoBitsPerSecond:1500000});
  const chunks=[];let bytes=0,failed=false,settle;
  savePromise=new Promise(resolve=>{settle=resolve;});recorder=current;
  current.ondataavailable=e=>{if(e.data.size){bytes+=e.data.size;if(bytes>128*1024*1024){failed=true;stopRecording();}else chunks.push(e.data);}};
  current.onerror=()=>{failed=true;stopRecording();};
  current.onstop=async()=>{
   clearTimeout(recordTimer);recorder=null;microphone?.getTracks().forEach(t=>t.stop());microphone=null;
   controls();$('recordStatus').textContent='Saving recording on this device…';
   try{
    if(failed||!bytes)throw Error('Recording could not be saved. Try a shorter recording.');
    await api('/recordings',{method:'POST',headers:{'Content-Type':type},body:new Blob(chunks,{type})});
    $('recordStatus').textContent='Recording saved on this device.';await loadRecordings();
   }catch(e){$('recordStatus').textContent=e.message;}
   finally{chunks.length=0;savePromise=null;settle();controls();}
  };
  current.start(1000);recordTimer=setTimeout(stopRecording,5*60*1000);
  $('recordStatus').textContent='Recording Ellie';
 }catch(e){microphone?.getTracks().forEach(t=>t.stop());microphone=null;savePromise=null;recorder=null;$('recordStatus').textContent='Could not start recording. Allow microphone access and try again.';}
 finally{recordStarting=false;controls();}
}
function stopRecording(){if(recorder?.state==='recording'){recorder.stop();$('stopRecord').disabled=true;}return savePromise;}
async function loadRecordings(){
 try{const result=await api('/recordings');$('recordings').replaceChildren();
 for(const item of result.recordings.slice().reverse()){
  const a=document.createElement('a');a.href=item.url;a.download=item.id;a.textContent=new Date(item.modified).toLocaleString()+' · Save recording';$('recordings').append(a);
 }
 if(!result.recordings.length)$('recordings').textContent='No recordings on this device.';
 }catch(e){$('recordings').textContent=e.message;}
}
function suspend(){model.pause();stopCamera(false);controls();}
const bar=mountDoorBar(document.body,{appPath:'/slp-videos/',
 onPause(){paused=true;suspend();},onResume(){paused=false;if(wanted)void startCamera();controls();},
 onLeave(){gone=true;suspend();return savePromise;},
 onLock(){suspend();},onUnlock(){controls();if(wanted)void startCamera();}});
$('partnerToggle').onclick=()=>{const open=$('partner').hidden;$('partner').hidden=!open;$('partnerToggle').setAttribute('aria-expanded',String(open));if(open){void cameraOptions();void loadRecordings();}};
$('camera').onclick=()=>camera?stopCamera():void startCamera();
$('cameraSelect').onchange=()=>{const restart=!!camera;selectedCameraId=$('cameraSelect').value;selectedCameraLabel=selectedCameraId?$('cameraSelect').selectedOptions[0].textContent:'';saveCameraPreference(wanted);stopCamera(false);if(restart)void startCamera();};
$('record').onclick=startRecording;$('stopRecord').onclick=stopRecording;
$('previous').onclick=()=>choose(index-1);$('next').onclick=()=>choose(index+1);
async function play(){if(!active()||!clips.length)return;try{await model.play();$('videoStatus').textContent=`${index+1} of ${clips.length}`;}catch{$('videoStatus').textContent='This video cannot play here. Try an H.264 MP4 copy.';}controls();}
$('play').onclick=()=>{if(!active())return;if(model.paused)void play();else model.pause();};
$('replay').onclick=()=>{if(!active()||!clips.length)return;model.currentTime=0;void play();};
for(const event of ['play','pause','ended'])model.addEventListener(event,controls);
model.onerror=()=>{$('videoStatus').textContent='This video cannot play here. Try an H.264 MP4 copy.';controls();};
$('refresh').onclick=refresh;
$('folder').oninput=()=>{$('folder').dataset.edited='true';};
$('folderForm').onsubmit=async e=>{e.preventDefault();if(!active())return;try{await api('/config',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({folder:$('folder').value})});delete $('folder').dataset.edited;await refresh();}catch(e){$('sourceStatus').textContent=e.message;}};
$('importFiles').onchange=async()=>{
 const files=[...$('importFiles').files];$('importFiles').disabled=true;
 try{for(const file of files){await api('/library?name='+encodeURIComponent(file.name),{method:'PUT',headers:{'Content-Type':file.type||'application/octet-stream'},body:file});}await refresh();}
 catch(e){$('sourceStatus').textContent=e.message;}finally{$('importFiles').disabled=false;$('importFiles').value='';}
};
fetch('/settings').then(r=>r.json()).then(s=>{
 if(Number.isFinite(s.dwellMs)&&s.dwellMs>0){window.Dwell?.setMs(s.dwellMs);bar.setDwell(s.dwellMs);}
 if(Number.isFinite(s.musicVolCap))volume=Math.max(0,Math.min(1,s.musicVolCap/100));
 if(Number.isFinite(s.settleMs))window.Dwell?.set({settleMs:Math.max(0,Math.min(2000,s.settleMs))});
 model.volume=volume;bar.setPause(s.pauseGoes==='tdsnap');
}).catch(()=>{}).finally(()=>{ready=true;void refresh();if(wanted)void startCamera();});
document.addEventListener('visibilitychange',()=>{
 if(document.visibilityState!=='visible')suspend();else{if(wanted)void startCamera();void refresh();controls();}
});
addEventListener('pagehide',()=>{gone=true;suspend();clearInterval(refreshTimer);});
refreshTimer=setInterval(()=>{if(active()&&!recorder&&!savePromise&&model.paused)void refresh();},30000);
controls();
