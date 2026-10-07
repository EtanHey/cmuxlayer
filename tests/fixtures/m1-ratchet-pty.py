"""Private synthetic PTY only: no cmux/app/model/auth/API."""
import json,os,pty,select,subprocess,sys,time
from pathlib import Path
node,repository,manifest,mode,fault=sys.argv[1:]
r=json.loads(Path(manifest).read_text()); root=Path(r["root"])
surface="aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"; workspace="bbbbbbbb-cccc-dddd-eeee-ffffffffffff"
env=dict(os.environ,CMUX_SURFACE_ID=surface,CMUX_WORKSPACE_ID=workspace)
master,slave=pty.openpty(); frames=[]
command="repoGolem() { :; }; source '"+r["attestation"]["registry"]+"'; ratchetCodex -m gpt-6-luna -E low -w '"+str(root/"repo")+"'"
proc=subprocess.Popen(["/bin/zsh","-dfc",command],stdin=slave,stdout=slave,stderr=slave,cwd=root/"repo",env=env)
os.close(slave)
def drain():
 while select.select([master],[],[],0)[0]:
  try: chunk=os.read(master,65536)
  except OSError: break
  if not chunk: break
  frames.append(chunk)
def wait(check):
 end=time.monotonic()+5
 while time.monotonic()<end:
  drain()
  if proc.poll() is not None: raise RuntimeError(b"".join(frames).decode(errors="replace"))
  try:
   v=json.loads(Path(r["events"]).read_text())
   if check(v): return v
  except (FileNotFoundError,json.JSONDecodeError): pass
  time.sleep(.015)
 raise RuntimeError("PTY timeout: "+b"".join(frames).decode(errors="replace"))
try:
 first=wait(lambda v:True); state=wait(lambda v:v["phase"]=="idle")
 token="FIXTURE_TOKEN"; pointer="cmuxlayer contract for fixture: Read and follow /private/fixture/contract.md"
 payload=token+" ; "+pointer+"\r" if mode=="folded" else token+"\n\n"+pointer
 os.write(master,payload.encode()); state=wait(lambda v:v["phase"]=="working")
 pid=state["pid"]; start=subprocess.check_output(["ps","-p",str(pid),"-o","lstart="],text=True).strip()
 binding=dict(pid=pid,start=start,surface=surface,workspace=workspace)
 if fault=="pid": state["pid"]=pid+1
 if fault=="surface": state["surface"]="foreign"
 if fault=="argv": state["argv"]=[node,"/foreign.mjs"]
 if fault=="row": state["row"]="banner"
 if fault=="start": binding["start"]="recycled"
 if fault=="registry": Path(r["attestation"]["registry"]).write_text("repoGolem missing /missing\n")
 Path(r["events"]).write_text(json.dumps(state))
 code="import * as guard from "+json.dumps(str(Path(repository)/"scripts/xmac/fixture-attestation.mjs"))+"; import{readFileSync}from'node:fs'; try{console.log(JSON.stringify({ok:true,observed:guard.attestFixtureProcess(JSON.parse(readFileSync(process.argv[1])),JSON.parse(process.argv[2]),process.env)}))}catch(e){console.log(JSON.stringify({ok:false,error:String(e)}))}"
 witness=subprocess.check_output([node,"--input-type=module","-e",code,manifest,json.dumps(binding)],text=True,env=env)
 drain(); print(json.dumps(dict(first=first,state=state,witness=json.loads(witness),screen=b"".join(frames).decode(errors="replace"))))
finally:
 proc.terminate()
 try: proc.wait(timeout=3)
 except subprocess.TimeoutExpired: proc.kill(); proc.wait(timeout=3)
 # fixture is the known event PID, not a pattern; stop only our recorded child.
 if "pid" in locals():
  try:
   current=subprocess.check_output(["ps","-p",str(pid),"-o","lstart="],text=True).strip()
   executable=subprocess.check_output(["ps","-p",str(pid),"-o","comm="],text=True).strip()
   if current==start and Path(executable).resolve()==Path(node).resolve(): os.kill(pid,15)
  except (ProcessLookupError,subprocess.CalledProcessError): pass
 os.close(master)
