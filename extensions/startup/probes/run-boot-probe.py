#!/usr/bin/env python3
import argparse
import gzip
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import time
import uuid

parser=argparse.ArgumentParser()
parser.add_argument('--workspace',type=Path,required=True)
parser.add_argument('--evidence',type=Path,required=True)
args=parser.parse_args()
repo=Path(__file__).resolve().parents[3]
workspace=args.workspace.resolve()
if not workspace.is_relative_to(repo/'.superpowers/sdd/2026-10-13-startup-v6/native-scratch'):
    raise ValueError('Boot proof requires plan scratch isolation')
workspace.mkdir(parents=True,exist_ok=False)
profile='startup-boot-'+uuid.uuid4().hex[:10]
env={key:value for key,value in os.environ.items() if key in {'PATH','HOME','TMPDIR','LANG','TERM','SHELL','USER','LOGNAME'}}
env.update({'PI_CONFIG_DIR':'.omp-'+profile,'XDG_DATA_HOME':str(workspace/'data'),'XDG_STATE_HOME':str(workspace/'state'),'XDG_CACHE_HOME':str(workspace/'cache'),'JP_SKILLS_HOME':str(workspace/'home'),'STARTUP_EXECUTION_LIMIT':'5','STARTUP_BOOT_EVENTS':str(workspace/'events.jsonl'),'STARTUP_BOOT_SOURCES':str(repo),'STARTUP_BOOT_BOUND':str(workspace/'bound')})
for kind in ['data','state','cache']:
    (workspace/kind/'omp/profiles'/profile).mkdir(parents=True)
bound=workspace/'bound';bound.mkdir()
cwd=bound/'native-cwd';cwd.mkdir()
prior=b'User bytes\r\nKeep this exactly\r\n'
(bound/'AGENTS.md').write_bytes(prior)
(cwd/'.omp/agents').mkdir(parents=True)
(cwd/'.omp/agents/user.md').write_text('---\nname: user-owned\ndescription: User profile\n---\nKeep user instructions.\n')
config=workspace/'config.yml'
config.write_text('task:\n  batch: true\n  agentIdleTtlMs: 0\n  speculativeLaunch: false\nasync:\n  enabled: true\nproviders:\n  cacheWarming: false\nmemories:\n  enabled: false\nmcp:\n  enableProjectConfig: false\n')
plugins=workspace/'data/omp/profiles'/profile/'plugins';plugins.mkdir()
lock=plugins/'omp-plugins.lock.json'
prior_lock=b'{"plugins": {}, "settings": {"user-plugin": {"keep": true}}}\n'
lock.write_bytes(prior_lock)
evidence={'status':'FAIL','checks':{},'profile':profile,'environment':{key:value for key,value in env.items() if key not in {'PATH','HOME','TMPDIR','LANG','TERM','SHELL','USER','LOGNAME'}},'commands':[]}
def run(command):
    result=subprocess.run(command,env=env,cwd=cwd,text=True,capture_output=True)
    evidence['commands'].append({'args':command,'exit':result.returncode,'stdout':result.stdout,'stderr':result.stderr})
    if result.returncode:raise RuntimeError(result.stdout+result.stderr)
    return result
omp=shutil.which('omp')
command=[omp,'--profile',profile,'--mode','rpc','--no-ui','--cwd',str(cwd),'--config',str(config),'--no-skills','--no-rules','--no-lsp','--no-pty','--no-title','--tools','task,read,write','--extension',str(Path(__file__).with_name('native-boot.ts')),'--model','startup-boot/offline','--thinking','off','--auto-approve']
process=None
try:
    install=run(['bun',str(repo/'extensions/startup/install.ts'),'install',profile])
    evidence['checks']['nativePluginPath']=json.loads(install.stdout)['plugins']==str(plugins)
    run(['bun',str(repo/'extensions/startup/install.ts'),'install',profile])
    def records():
        file=workspace/'events.jsonl'
        return [json.loads(line) for line in file.read_text().splitlines()] if file.exists() else []
    def wait(predicate):
        deadline=time.monotonic()+45
        while time.monotonic()<deadline:
            if predicate():return
            if process.poll() is not None:raise RuntimeError('Native process exited')
            time.sleep(.05)
        raise TimeoutError('Compiled boot evidence timeout')
    def send(message,images):
        process.stdin.write(json.dumps({'type':'prompt','id':uuid.uuid4().hex,'message':message,'images':images})+'\n');process.stdin.flush()
    def start():
        evidence['commands'].append({'args':command})
        return subprocess.Popen(command,env=env,cwd=cwd,stdin=subprocess.PIPE,stdout=(workspace/'stdout.jsonl').open('a'),stderr=(workspace/'stderr.txt').open('a'),text=True)
    process=start()
    wait(lambda:any(row['kind']=='start' for row in records()))
    first=next(row for row in records() if row['kind']=='start')
    evidence['checks']['lazyNativeTranscript']=not first['onDisk']
    work='/startup new native-proof --dir '+json.dumps(str(bound))+' -- '+('FULL_INTAKE '*700)+'TAIL'
    image={'type':'image','mimeType':'image/png','data':'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII='}
    send(work,[image])
    wait(lambda:any(row['kind']=='tool' and row['name']=='startup_capture' and not row['error'] for row in records()))
    wait(lambda:any(row['kind']=='stop' for row in records()))
    send('/startup-boot-inspect',[])
    wait(lambda:any(row['kind']=='inspect' for row in records()))
    inspect=next(row for row in records() if row['kind']=='inspect')
    evidence['inspect']=inspect
    evidence['checks']['actualRunningVersion']=inspect['version']=='18.8.9'
    evidence['checks']['materializedTranscript']=inspect['onDisk']
    evidence['checks']['explicitLimit']=inspect['staff']['details']['capacity']['explicitLimit']==5
    evidence['checks']['installedTools']='startup_staff' in inspect['tools']
    evidence['checks']['boundGuidance']=(bound/'AGENTS.md').read_bytes().startswith(prior) and not (cwd/'AGENTS.md').exists()
    providers=[row for row in records() if row['kind']=='provider']
    evidence['checks']['canonicalComplete']=all(row['roleComplete'] and row['loopComplete'] and row['guidance'] for row in providers)
    evidence['checks']['nativeChildCwdProfiles']=len(list((cwd/'.omp/agents').glob('startup-*.md')))==3
    evidence['checks']['userProfilePreserved']=(cwd/'.omp/agents/user.md').read_text().endswith('Keep user instructions.\n')
    pages=[row['details'] for row in records() if row['kind']=='tool' and row['name']=='startup_input' and not row['error']]
    evidence['checks']['fullPagedInput']=''.join(row['text'] for row in pages)==work
    images=[row for row in records() if row['kind']=='tool' and row['name']=='startup_image' and not row['error']]
    evidence['checks']['nativeImages']=any(row['content']==[image] for row in images)
    process.stdin.close();process.wait(timeout=10);process=None
    before=(bound/'AGENTS.md').read_bytes()
    env['STARTUP_EXECUTION_LIMIT']='4'
    command.extend(['--session',inspect['file']])
    process=start()
    count=sum(row['kind']=='inspect' for row in records())
    wait(lambda:sum(row['kind']=='start' for row in records())>=2)
    send('/startup-boot-inspect',[])
    wait(lambda:sum(row['kind']=='inspect' for row in records())>count)
    evidence['checks']['limitPrecedence']=[row for row in records() if row['kind']=='inspect'][-1]['staff']['details']['capacity']['explicitLimit']==4
    evidence['checks']['restartDiscovery']=records()[-1]['kind']=='inspect' and (bound/'AGENTS.md').read_bytes()==before
    process.stdin.close();process.wait(timeout=10);process=None
    malformed=b'User unchanged\n<!-- jp-skills-startup:begin -->'
    (bound/'AGENTS.md').write_bytes(malformed)
    env['STARTUP_BOOT_FAILURE']='1'
    process=start()
    wait(lambda:any(row['kind']=='failure-guards' for row in records()))
    guards=next(row for row in records() if row['kind']=='failure-guards')
    evidence['checks']['nativeFailureGuards']=guards['input'].get('handled') is True and guards['tool'].get('block') is True and guards['stop'].get('continue') is True
    evidence['checks']['failedGuidancePreserved']=(bound/'AGENTS.md').read_bytes()==malformed
    process.stdin.close();process.wait(timeout=10);process=None
    (bound/'AGENTS.md').write_bytes(before)
    run(['bun',str(repo/'extensions/startup/install.ts'),'uninstall',profile])
    evidence['checks']['uninstallPreservesConfig']=lock.read_bytes()==prior_lock
    evidence['checks']['uninstallOnlyOwned']=not (plugins/'node_modules/@jp-skills/startup').exists() and (cwd/'.omp/agents/user.md').exists() and (workspace/'home/startup/native-proof/staff.sqlite').exists()
    if not all(evidence['checks'].values()):raise AssertionError(evidence['checks'])
    evidence['status']='PASS'
except Exception as error:
    evidence['failure']={'kind':type(error).__name__,'message':str(error)}
    raise
finally:
    if process is not None:process.terminate();process.wait(timeout=10)
    if (plugins/'jp-skills-startup.install.json').exists():
        run(['bun',str(repo/'extensions/startup/install.ts'),'uninstall',profile])
    evidence['events']=[json.loads(line) for line in (workspace/'events.jsonl').read_text().splitlines()] if (workspace/'events.jsonl').exists() else []
    evidence['stderr']=(workspace/'stderr.txt').read_text() if (workspace/'stderr.txt').exists() else ''
    sources=[repo/'extensions/startup/index.ts',repo/'extensions/startup/install.ts',repo/'extensions/startup/package.json',*sorted((repo/'extensions/startup/src').glob('*.ts')),*sorted((repo/'skills').glob('startup*/**/*.md')),repo/'skills/hire/SKILL.md',Path(__file__),Path(__file__).with_name('native-boot.ts')]
    evidence['sourceHashes']={str(path.relative_to(repo)):hashlib.sha256(path.read_bytes()).hexdigest() for path in sources}
    with gzip.open(args.evidence,'wt') as file:json.dump(evidence,file)
    print(json.dumps({key:evidence[key] for key in ['status','checks']}))
