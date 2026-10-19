import fs from 'node:fs/promises';
import path from 'node:path';

// CDP workers share Brave's download settings. A short-lived worker's temporary
// directory can disappear; use durable storage and identify this frame's download.
export async function persistentBrowserDownload({browser,page,click,directory,output,timeoutMs=90000}) {
  directory=path.resolve(directory);await fs.mkdir(directory,{recursive:true});
  const session=await browser.newBrowserCDPSession();
  const frameSession=await page.context().newCDPSession(page);
  let timer,begin,progress;
  try {
    const {frameTree}=await frameSession.send('Page.getFrameTree');
    let guid;
    const finished=new Promise((resolve,reject)=>{
      timer=setTimeout(()=>reject(new Error('CSV download did not complete within its time limit')),timeoutMs);
      begin=event=>{
        if(event.frameId!==frameTree.frame.id)return;
        if(!/^[a-f0-9-]{16,}$/i.test(event.guid)){reject(new Error('Invalid download identifier'));return;}
        guid=event.guid;
      };
      progress=event=>{
        if(!guid||event.guid!==guid)return;
        if(event.state==='completed')resolve(path.join(directory,guid));
        if(event.state==='canceled')reject(new Error('CSV download was canceled; saved contacts remain in GrowMeOrganic'));
      };
      session.on('Browser.downloadWillBegin',begin);session.on('Browser.downloadProgress',progress);
    });
    await session.send('Browser.setDownloadBehavior',{behavior:'allowAndName',downloadPath:directory,eventsEnabled:true});
    const [downloaded]=await Promise.all([finished,click()]);
    await fs.copyFile(downloaded,output+'.part');await fs.rename(output+'.part',output);
    await fs.rm(downloaded,{force:true});return output;
  } finally {
    clearTimeout(timer);
    if(begin)session.off('Browser.downloadWillBegin',begin);
    if(progress)session.off('Browser.downloadProgress',progress);
    await session.send('Browser.setDownloadBehavior',{behavior:'default',eventsEnabled:false}).catch(()=>{});
    await frameSession.detach().catch(()=>{});await session.detach().catch(()=>{});
  }
}
