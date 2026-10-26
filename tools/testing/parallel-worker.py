#!/usr/bin/env python3
"""Owned host admission and isolated execution of an unchanged candidate gate."""
import ctypes,fcntl,hashlib,json,os,pathlib,re,shutil,signal,socket,subprocess,sys,threading,time,uuid
os.umask(0o077)
sys.dont_write_bytecode=True
HERE=pathlib.Path(__file__).resolve().parent
LOOPBACK='.'.join(map(str,[127,0,0,1]))
DUMMY='.'.join(map(str,[192,0,2,1]))

def write(file,value):
    file=pathlib.Path(file);file.parent.mkdir(parents=True,exist_ok=True)
    temp=file.with_name(file.name+'.'+str(os.getpid())+'.tmp')
    temp.write_text(json.dumps(value,indent=2)+'\n');temp.replace(file)

def read(file):return json.loads(pathlib.Path(file).read_text())
def identity(pid):
    text=pathlib.Path('/proc/'+str(pid)+'/stat').read_text();parts=text[text.rfind(')')+2:].split()
    return {'pid':pid,'startTicks':parts[19]}
def owned_alive(record):
    try:return identity(record['pid'])==record
    except (FileNotFoundError,ProcessLookupError):return False

def stop_owned(process,record):
    if process.poll() is not None:return
    if not owned_alive(record):raise RuntimeError('Owned child identity changed; cleanup refused')
    text=pathlib.Path('/proc/'+str(process.pid)+'/stat').read_text();parent=int(text[text.rfind(')')+2:].split()[1])
    if parent!=os.getpid():raise RuntimeError('Cleanup child has a different parent')
    process.terminate()
    try:process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        if owned_alive(record):process.kill()
        process.wait(timeout=5)

def release_owned_job(job,child,record,admitted):
    # A failed worker must retain admission until its own launcher has exited.
    if child is not None and child.poll() is None:stop_owned(child,record)
    if admitted:
        try:run_internal(job,'_release')
        except Exception as error:write(job/'lease-release-error.json',{'error':str(error)})

def sha(file):return hashlib.sha256(pathlib.Path(file).read_bytes()).hexdigest()

def run_internal(job,command):
    request=read(job/'request.json');cli=job/'control/parallel-gate.mjs'
    result=subprocess.run([request['runtime']['node'],str(cli),command,str(job)],text=True,capture_output=True,env={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','LANG':'C.UTF-8','TZ':'UTC'})
    if result.returncode:raise RuntimeError(result.stderr.strip() or result.stdout.strip() or command+' failed')
    return json.loads(result.stdout)

def status(job,state,**extra):
    current={}
    try:current=read(job/'status.json')
    except FileNotFoundError:pass
    write(job/'status.json',{**current,'status':state,'updated':time.time(),**extra})

def copy_tree(source,destination):
    source=pathlib.Path(source).resolve()
    for directory,dirs,files in os.walk(source,followlinks=False):
        for name in dirs+files:
            entry=pathlib.Path(directory)/name
            if entry.is_symlink():
                target=entry.resolve()
                if not target.is_relative_to(source):raise RuntimeError('Runtime link escapes its package')
            elif not entry.is_file() and not entry.is_dir():raise RuntimeError('Unsupported runtime entry')
    shutil.copytree(source,destination,symlinks=True)

def pin_runtime(job):
    request=read(job/'request.json');description=request['runtime'];runtime=job/'runtime'
    (runtime/'bin').mkdir(parents=True);(runtime/'lib').mkdir();(runtime/'browsers').mkdir()
    shutil.copyfile(description['node'],runtime/'bin/node');(runtime/'bin/node').chmod(0o755)
    node_version=subprocess.check_output([str(runtime/'bin/node'),'--version'],text=True).strip()
    if node_version!=description['nodeVersion']:raise RuntimeError('Node runtime changed after queueing')
    modules=job/'workspace/node_modules';modules.mkdir()
    for package in description['packages']:copy_tree(package['source'],modules/package['name'])
    executables=[runtime/'bin/node']
    for browser in description['browsers']:
        target=runtime/'browsers'/browser['name'];copy_tree(browser['source'],target)
        for file in target.rglob('*'):
            if file.is_file() and file.name in ['chrome','headless_shell','chrome-headless-shell']:executables.append(file)
    libraries={}
    for executable in executables:
        result=subprocess.run(['ldd',str(executable)],capture_output=True,text=True)
        if result.returncode:raise RuntimeError('Cannot pin executable shared libraries')
        for line in result.stdout.splitlines():
            if 'not found' in line:raise RuntimeError('A runtime library is missing')
            match=re.search(r'(/[^\s]+)',line)
            if not match:continue
            source=pathlib.Path(match.group(1))
            if source.is_file():
                digest=sha(source)
                if source.name in libraries and libraries[source.name]!=digest:raise RuntimeError('Conflicting runtime libraries')
                libraries[source.name]=digest;shutil.copyfile(source,runtime/'lib'/source.name)
    write(job/'runtime-description.json',{'nodeVersion':node_version,'nodeHash':sha(runtime/'bin/node'),'libraries':libraries})
    # The same production identity implementation hashes the owned runtime tree.
    cli=job/'control/parallel-gate.mjs'
    result=subprocess.run([description['node'],str(cli),'_runtime',str(job)],capture_output=True,text=True)
    if result.returncode:raise RuntimeError(result.stderr.strip() or 'Runtime identity failed')

def namespace_checks():
    stat=pathlib.Path('/proc/self/stat').read_text()
    if int(stat.split(' ',1)[0])!=os.getpid() or os.getpid()!=1:raise RuntimeError('A fresh PID namespace and proc mount are required before any gate command')
    caps=next(line.split()[1] for line in pathlib.Path('/proc/self/status').read_text().splitlines() if line.startswith('CapEff:'))
    if os.getuid()==0 or int(caps,16):raise RuntimeError('Gate requires a nonzero UID and zero capabilities')
    if subprocess.check_output(['ip','route','show','default'],text=True).strip():raise RuntimeError('Namespace must have no egress route')
    probe=pathlib.Path('/tmp/permission-proof');probe.write_text('owned');probe.chmod(0)
    try:
        probe.read_text();raise RuntimeError('Permission regressions would be bypassed')
    except PermissionError:pass
    finally:probe.chmod(0o600);probe.unlink()
    return {'uid':os.getuid(),'capEff':caps,'pid':os.getpid(),'pidNamespace':os.readlink('/proc/self/ns/pid'),'netNamespace':os.readlink('/proc/self/ns/net'),'freshProc':True,'noEgress':True}

def enter_script(job,masks):
    # Mounts are private before any overlay. Only prepared job paths stay visible.
    script='''#!/usr/bin/env bash
set -euo pipefail
parallel_job="$1"
mount -n -t tmpfs -o mode=1777 tmpfs /tmp
mkdir -p /tmp/owned-job
mount -n --bind "$parallel_job" /tmp/owned-job
mount -n -t tmpfs -o "mode=700,uid=$4,gid=$5" tmpfs "$3"
mkdir -p "$parallel_job"
mount -n --bind /tmp/owned-job "$parallel_job"
umount -n /tmp/owned-job
rmdir /tmp/owned-job
mount -n -o remount,ro "$3"
mount -n -t tmpfs -o mode=1777 tmpfs /dev/shm
mount -n -t tmpfs -o mode=1777 tmpfs /var/tmp
ip link set lo up
ip link add test-link type dummy
ip addr add "$2/24" dev test-link
ip link set test-link up
mkdir -p /tmp/hidden
'''
    for index,mask in enumerate(masks):
        script+='mkdir -p /tmp/hidden/'+str(index)+'\n'
        # Values are passed as positional arguments; no source path becomes shell code.
        argument=index+6
        script+='mount -n --bind /tmp/hidden/'+str(index)+' "${'+str(argument)+'}"\n'
        script+='mount -n -o remount,bind,ro "${'+str(argument)+'}"\n'
    script+='''if [ -d "$parallel_job/runtime" ]; then
mount -n --bind "$parallel_job/runtime" "$parallel_job/runtime"
mount -n -o remount,bind,ro "$parallel_job/runtime"
fi
if [ -d "$parallel_job/workspace/node_modules" ]; then
mount -n --bind "$parallel_job/workspace/node_modules" "$parallel_job/workspace/node_modules"
mount -n -o remount,bind,ro "$parallel_job/workspace/node_modules"
fi
exec setpriv --inh-caps=-all --ambient-caps=-all --bounding-set=-all --no-new-privs python3 "$parallel_job/inside-worker.py" inside "$parallel_job"
'''
    file=job/'enter.sh';file.write_text(script);return file

def masks_for(job,manifest=None):
    home=pathlib.Path.home().resolve()
    if not job.is_relative_to(home):raise RuntimeError('Owned jobs must be under the current home directory')
    masks=[pathlib.Path('/run')]
    driver_repo=HERE.parent.parent
    if (driver_repo/'server.js').is_file() and not job.is_relative_to(driver_repo.parent):masks.append(driver_repo.parent.resolve())
    if manifest:
        for origin in manifest['origins'].values():
            parent=pathlib.Path(origin['origin']).resolve().parent
            if not job.is_relative_to(parent):masks.append(parent)
            else:raise RuntimeError('Snapshot jobs must be outside the original source workspace')
    # The whole home is replaced, including credentials and paths outside source roots.
    masks=[p for p in masks if not p.is_relative_to(home)]
    masks=sorted(set(masks),key=lambda p:len(str(p)))
    return [p for p in masks if not any(p!=other and p.is_relative_to(other) for other in masks)]

def parent_death(expected_parent):
    if ctypes.CDLL(None).prctl(1,signal.SIGKILL)!=0:os._exit(125)
    if os.getppid()!=expected_parent:os._exit(125)

def start_namespace(job,masks):
    shutil.copyfile(pathlib.Path(__file__).resolve(),job/'inside-worker.py')
    script=enter_script(job,masks)
    write(job/'masked-paths.json',{'emptyMasks':[str(p) for p in masks],'home':str(pathlib.Path.home().resolve())})
    args=['unshare','--user','--map-current-user','--keep-caps','--mount','--net','--pid','--fork','--mount-proc','--propagation','private','--kill-child=KILL','bash',str(script),str(job),DUMMY,str(pathlib.Path.home().resolve()),str(os.getuid()),str(os.getgid()),*map(str,masks)]
    output=(job/'namespace.log').open('w')
    expected_parent=os.getpid()
    child=subprocess.Popen(args,stdout=output,stderr=subprocess.STDOUT,env={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','LANG':'C.UTF-8','TZ':'UTC'},preexec_fn=lambda:parent_death(expected_parent))
    write(job/'namespace-launch.json',identity(child.pid));return child,output

def inside(job):
    checks=namespace_checks()
    isolation=read(job/'masked-paths.json');masks=isolation['emptyMasks']
    for mask in masks:
        if list(pathlib.Path(mask).iterdir()):raise RuntimeError('A masked live path is still visible')
    # Only the path to this owned job may remain below the replaced home.
    cursor=pathlib.Path(isolation['home']);relative=job.relative_to(cursor)
    for name in relative.parts:
        if sorted(p.name for p in cursor.iterdir())!=[name]:raise RuntimeError('Host home remains visible outside the owned job')
        cursor=cursor/name
    checks.update({'maskedPaths':len(masks)+1,'homeMasked':True,'runMasked':'/run' in masks});write(job/'namespace-proof.json',checks)
    if (job/'preflight.json').exists():return inside_preflight(job,checks)
    if (job/'reverse-preflight.json').exists():return inside_reverse_preflight(job,checks)
    if (job/'reverse-inner.json').exists():return inside_reverse_inner(job)
    manifest=read(job/'manifest.json');env=read(job/'gate-env.json')
    script=pathlib.Path(manifest['hub'])/'tools/era-gate.sh'
    before=sha(script);start=time.monotonic()
    with (job/'gate.log').open('w') as output:
        gate=subprocess.Popen(['bash',str(script)],cwd=manifest['hub'],env=env,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,bufsize=1)
        completed=0;failed=0
        for line in gate.stdout:
            output.write(line);output.flush()
            match=re.match(r'^(PASS|FAIL) (\S+)',line)
            if match:
                completed+=1;failed+=int(match[1]=='FAIL')
                write(job/'progress.json',{'completed':completed,'failed':failed,'lastSuite':match[2],'elapsed':round(time.monotonic()-start,1)})
        code=gate.wait()
    if sha(script)!=before:raise RuntimeError('Candidate gate script changed while executing')
    write(job/'gate-exit.json',{'code':code,'gateSeconds':round(time.monotonic()-start,3),'gateSha256':before,'unchanged':True})
    return code

def preflight(job,node):
    job.mkdir(parents=True,exist_ok=True)
    script=job/'server.js'
    script.write_text("const fs=require('node:fs'),net=require('node:net');const s=net.createServer(c=>c.end('owned'));s.listen(Number(process.argv[3]),process.argv[5],()=>fs.writeFileSync(process.argv[4],String(process.pid)));setInterval(()=>{},1000);\n")
    port=None
    for candidate in range(8389,8379,-1):
        with socket.socket() as probe:
            try:probe.bind((LOOPBACK,candidate));port=candidate;break
            except OSError:pass
    if port is None:raise RuntimeError('No approved host preflight canary port is free')
    ready=job/'host-canary.ready'
    owned_node=job/'probe-node';shutil.copyfile(node,owned_node);owned_node.chmod(0o755)
    home_probe=job.parent/('parallel-host-probe-'+uuid.uuid4().hex)
    home_probe.write_text('owned host-only probe')
    canary=subprocess.Popen([node,str(script),str(port),str(port),str(ready),LOOPBACK],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    record=identity(canary.pid)
    lock=pathlib.Path('/tmp')/('parallel-probe-'+uuid.uuid4().hex+'.lock')
    try:
        for _ in range(100):
            if ready.exists():break
            if canary.poll() is not None:raise RuntimeError('Owned host canary failed')
            time.sleep(.02)
        if not ready.exists():raise RuntimeError('Owned host canary did not become ready')
        with lock.open('x') as held:
            fcntl.flock(held,fcntl.LOCK_EX|fcntl.LOCK_NB)
            lock_stat=os.fstat(held.fileno())
            write(job/'preflight.json',{'node':str(owned_node),'canary':record,'port':port,'lock':str(lock),'hostLockIdentity':[lock_stat.st_dev,lock_stat.st_ino],'homeProbe':str(home_probe)})
            child,output=start_namespace(job,masks_for(job))
            try:code=child.wait(timeout=20)
            finally:output.close()
            if code:raise RuntimeError((job/'namespace.log').read_text())
        if canary.poll() is not None or not owned_alive(record):raise RuntimeError('Host canary did not survive isolated legacy cleanup')
        result=read(job/'preflight-result.json');result['hostCanarySurvived']=True
        write(job/'preflight-result.json',result);print(json.dumps(result),flush=True)
    finally:
        stop_owned(canary,record)
        lock.unlink(missing_ok=True)
        home_probe.unlink(missing_ok=True)

def inside_preflight(job,checks):
    request=read(job/'preflight.json')
    if pathlib.Path('/proc/'+str(request['canary']['pid'])).exists():raise RuntimeError('Fresh proc exposes the host canary')
    if pathlib.Path(request['homeProbe']).exists():raise RuntimeError('Host home remains visible')
    with socket.socket() as listener:
        listener.bind((LOOPBACK,request['port']));listener.listen()
        with pathlib.Path(request['lock']).open('w') as held:
            fcntl.flock(held,fcntl.LOCK_EX|fcntl.LOCK_NB)
            lock_stat=os.fstat(held.fileno())
            if [lock_stat.st_dev,lock_stat.st_ino]==request['hostLockIdentity']:raise RuntimeError('Temporary lock inode was shared with host')
        ready=pathlib.Path('/tmp/inner-canary.ready')
        inner=subprocess.Popen([request['node'],str(job/'server.js'),str(request['port']),'0',str(ready),LOOPBACK],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        for _ in range(100):
            if ready.exists():break
            if inner.poll() is not None:raise RuntimeError('Inner canary failed')
            time.sleep(.02)
        if not ready.exists():raise RuntimeError('Inner canary did not become ready')
        killed=subprocess.run(['pkill','-f','[n]ode .*server.js '+str(request['port'])])
        inner.wait(timeout=5)
        if killed.returncode or inner.returncode>=0:raise RuntimeError('Isolated legacy cleanup did not stop its own canary')
    write(job/'preflight-result.json',{**checks,'fixedPortIndependent':True,'temporaryLockIndependent':True,'hostCanaryVisible':False,'hostHomeProbeVisible':False,'ownedInnerCanaryStopped':True})
    return 0

def reverse_preflight(job,node):
    job.mkdir(parents=True,exist_ok=True)
    shutil.copyfile(node,job/'probe-node');(job/'probe-node').chmod(0o755)
    write(job/'reverse-preflight.json',{'node':str(job/'probe-node')})
    child,output=start_namespace(job,masks_for(job));record=identity(child.pid)
    try:
        if child.wait(timeout=20):raise RuntimeError((job/'namespace.log').read_text())
        print(json.dumps(read(job/'reverse-result.json')),flush=True)
    finally:
        stop_owned(child,record);output.close()

def inside_reverse_preflight(job,checks):
    # This simulated host has a fresh PID namespace containing only owned fixtures.
    node=read(job/'reverse-preflight.json')['node'];script=job/'server.js'
    script.write_text("const fs=require('node:fs'),net=require('node:net');let tick=0;const emit=()=>{fs.writeFileSync(process.argv[3]+'.tmp',String(++tick));fs.renameSync(process.argv[3]+'.tmp',process.argv[3]);};net.createServer(c=>c.end()).listen(Number(process.argv[2]),process.argv[4],()=>{emit();setInterval(emit,30);});\n")
    # A different control marker keeps real host legacy cleanup from disturbing this proof.
    control_port=8387
    legacy_ready=job/'legacy-ready';legacy=subprocess.Popen([node,str(script),str(control_port),str(legacy_ready),LOOPBACK]);legacy_record=identity(legacy.pid)
    inner=None;inner_record=None
    try:
        inner_job=job/'inner';inner_job.mkdir();shutil.copyfile(node,inner_job/'probe-node');(inner_job/'probe-node').chmod(0o755);shutil.copyfile(script,inner_job/'server.js')
        write(inner_job/'reverse-inner.json',{'node':str(inner_job/'probe-node')})
        inner,output=start_namespace(inner_job,masks_for(inner_job));inner_record=identity(inner.pid)
        for _ in range(200):
            if legacy_ready.exists() and (inner_job/'heartbeat').exists():break
            if legacy.poll() is not None or inner.poll() is not None:raise RuntimeError('A reverse isolation canary exited before readiness')
            time.sleep(.02)
        if not legacy_ready.exists() or not (inner_job/'heartbeat').exists():raise RuntimeError('Reverse isolation canaries did not become ready')
        expected=[str(inner_job/'probe-node'),str(inner_job/'server.js'),'8388',str(inner_job/'heartbeat'),LOOPBACK]
        matches=[]
        for entry in pathlib.Path('/proc').iterdir():
            if not entry.name.isdigit():continue
            try:arguments=(entry/'cmdline').read_bytes().rstrip(b'\0').decode().split('\0')
            except (FileNotFoundError,ProcessLookupError):continue
            if arguments==expected:matches.append(arguments)
        if len(matches)!=1 or re.search(r'node .*server.js 8378',' '.join(matches[0])):raise RuntimeError('The isolated gate command can match real host legacy cleanup')
        before=int((inner_job/'heartbeat').read_text())
        cleaned=subprocess.run(['pkill','-f','[n]ode .*server.js '+str(control_port)])
        legacy.wait(timeout=5)
        if cleaned.returncode or legacy.returncode>=0:raise RuntimeError('Simulated host cleanup did not stop its own legacy canary')
        time.sleep(.15)
        if inner.poll() is not None or int((inner_job/'heartbeat').read_text())<=before:raise RuntimeError('Simulated host cleanup stopped the isolated gate canary')
        write(inner_job/'finish.json',{'done':True})
        if inner.wait(timeout=5):raise RuntimeError('Inner canary cleanup failed')
        output.close()
        write(job/'reverse-result.json',{**checks,'hostLegacyPort':8378,'legacyControlPort':control_port,'isolatedGatePort':8388,'hostLegacyPatternMatched':False,'legacyHostCanaryStopped':True,'isolatedGateCanarySurvived':True})
        return 0
    finally:
        stop_owned(legacy,legacy_record)
        if inner is not None:stop_owned(inner,inner_record)

def inside_reverse_inner(job):
    node=read(job/'reverse-inner.json')['node'];heartbeat=job/'heartbeat'
    child=subprocess.Popen([node,str(job/'server.js'),'8388',str(heartbeat),LOOPBACK]);record=identity(child.pid)
    try:
        deadline=time.monotonic()+10
        while not (job/'finish.json').exists():
            if child.poll() is not None:raise RuntimeError('Isolated gate canary was stopped')
            if time.monotonic()>deadline:raise RuntimeError('Simulated host proof did not finish')
            time.sleep(.02)
        return 0
    finally:stop_owned(child,record)

def worker(job):
    from parallel_monitor import HostMonitor
    request=read(job/'request.json')
    if str(job)!=request['directory'] or not job.is_relative_to(pathlib.Path(request['state'])/'jobs'):raise RuntimeError('Unowned job directory')
    if os.getuid()==0:raise RuntimeError('Host worker must have a nonzero UID')
    (job/'worker.claim').mkdir()
    write(job/'worker.json',identity(os.getpid()))
    admitted=False;start=time.monotonic();result={};monitor=None;sampling_stop=threading.Event();sampler=None;child=None;namespace_record=None
    try:
        while True:
            pending=[]
            for entry in (pathlib.Path(request['state'])/'jobs').iterdir():
                if entry.is_symlink() or not entry.is_dir():continue
                try:
                    queued=read(entry/'request.json');state=read(entry/'status.json')['status']
                    if state in ['queued','waiting','preparing','running']:pending.append((queued['created'],queued['id']))
                except (FileNotFoundError,KeyError,ValueError):continue
            if pending and min(pending)[1]!=request['id']:
                status(job,'waiting',reason='An earlier isolated job is ahead in the queue');time.sleep(10);continue
            lease=run_internal(job,'_admit')
            if lease['acquired']:admitted=True;break
            status(job,'waiting',reason=lease.get('reason','Resource admission is pending'));time.sleep(10)
        # Admission observes all allowed host CPUs before restriction is applied.
        resources=lease['lease']['resources'];os.sched_setaffinity(0,{resources['cpu']})
        current=os.getpriority(os.PRIO_PROCESS,0)
        if current<resources['nice']:os.nice(resources['nice']-current)
        status(job,'preparing',resources=resources,started=time.time())
        monitor=HostMonitor(os.getpid(),identity(os.getpid())['startTicks'])
        def sample_memory():
            while not sampling_stop.is_set():
                monitor.sample()
                if sampling_stop.wait(2):break
        sampler=threading.Thread(target=sample_memory,daemon=True);sampler.start()
        run_internal(job,'_prepare');pin_runtime(job)
        manifest=read(job/'manifest.json');(job/'issued-stamps').mkdir()
        # Do not fork a Python pre-exec callback while a sampling thread is live.
        sampling_stop.set();sampler.join();monitor.sample()
        child,output=start_namespace(job,masks_for(job,manifest))
        namespace_record=identity(child.pid)
        sampling_stop.clear();sampler=threading.Thread(target=sample_memory,daemon=True);sampler.start()
        status(job,'running',namespace=namespace_record)
        try:
            while child.poll() is None:time.sleep(2)
        finally:output.close()
        if not (job/'gate-exit.json').exists():raise RuntimeError('Namespace exited before a gate receipt: '+(job/'namespace.log').read_text()[-2000:])
        result=run_internal(job,'_validate');gate=read(job/'gate-exit.json')
        result.update({'gateExitCode':gate['code'],'gateSeconds':gate['gateSeconds'],'elapsedSeconds':round(time.monotonic()-start,3)})
        write(job/'result.json',result)
        state='passed' if result['valid'] else 'stale' if result.get('stale') else 'failed'
        status(job,state,reason='; '.join(result.get('reasons',[])),finished=time.time())
    except Exception as error:
        result={'valid':False,'error':str(error),'elapsedSeconds':round(time.monotonic()-start,3)}
        write(job/'result.json',result);status(job,'failed',reason=str(error),finished=time.time())
    finally:
        if sampler:
            sampling_stop.set();sampler.join();monitor.sample()
            observations=monitor.summary();write(job/'memory-observations.json',observations)
            result['memoryObservations']=observations;write(job/'result.json',result)
        release_owned_job(job,child,namespace_record,admitted)
        write(job/'done.json',{'status':read(job/'status.json')['status'],'finished':time.time()})

if __name__=='__main__':
    mode=sys.argv[1];job=pathlib.Path(sys.argv[2]).resolve()
    if mode=='preflight':preflight(job,sys.argv[3])
    elif mode=='reverse-preflight':reverse_preflight(job,sys.argv[3])
    elif mode=='inside':raise SystemExit(inside(job))
    elif mode=='run':worker(job)
    else:raise SystemExit('Unknown owned worker mode')
