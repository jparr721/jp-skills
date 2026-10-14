#!/usr/bin/env python3
from probe_workspace import create_workspace, resume_workspace
import argparse
import gzip
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import time


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--workspace', type=Path, required=True)
    parser.add_argument('--evidence', type=Path, required=True)
    parser.add_argument('--scenario', choices=['raw','monitor','resume'], required=True)
    args = parser.parse_args()
    evidence = {'status': 'FAIL', 'checks': {}}
    def save():
        args.evidence.parent.mkdir(parents=True, exist_ok=True)
        temporary = args.evidence.with_suffix('.tmp')
        with gzip.open(temporary, 'wt') as output:
            json.dump(evidence, output)
        os.replace(temporary, args.evidence)
    save()
    try:
        repo = Path(__file__).resolve().parents[3]
        workspace = args.workspace.resolve()
        if args.scenario == 'resume':
            resume_workspace(workspace, repo, 'duties')
        else:
            create_workspace(workspace, repo, 'duties')
        cwd = workspace / 'cwd'
        cwd.mkdir(exist_ok=args.scenario=='resume')
        sources = repo
        (workspace/'state/omp').mkdir(parents=True,exist_ok=args.scenario=='resume')
        config = workspace / 'config.yml'
        config.write_text('task:\n  batch: true\n  agentIdleTtlMs: 0\n  speculativeLaunch: false\nasync:\n  enabled: true\nproviders:\n  cacheWarming: false\nmemories:\n  enabled: false\nmcp:\n  enableProjectConfig: false\n')
        env = {key: value for key, value in os.environ.items() if key in {'PATH','HOME','TMPDIR','LANG','LC_ALL','TERM','SHELL','USER','LOGNAME'}}
        env.update({'XDG_STATE_HOME':str(workspace/'state'),'PI_CODING_AGENT_DIR': str(workspace/'profile'), 'STARTUP_NAME': 'duty-proof', 'JP_SKILLS_HOME': str(workspace/'home'), 'STARTUP_SKILLS_ROOT': str(sources), 'STARTUP_ADAPTER_EVENTS': str(workspace/'events.jsonl'), 'STARTUP_ADAPTER_REPORT': str(workspace/'report.json')})
        omp = shutil.which('omp')
        if omp is None:
            raise FileNotFoundError('Installed compiled OMP required')
        command = [omp,'--mode','rpc','--no-ui','--cwd',str(cwd),'--config',str(config),'--no-extensions','--no-skills','--no-rules','--no-lsp','--no-pty','--no-title','--tools','task,read,write','--extension',str(repo/'extensions/startup/index.ts'),'--extension',str(Path(__file__).with_name('native-duties.ts')),'--model','startup-adapter/offline','--thinking','off','--auto-approve']
        if args.scenario=='resume':
            previous=json.loads((workspace/'report.json').read_text())
            command += ['--resume', previous['rootFile']]
            evidence['previous']=previous
            (workspace/'report.json').unlink()
            env['STARTUP_DUTY_RESUMED']='1'
        evidence.update({'command': command, 'installedVersion': subprocess.check_output([omp,'--version'],text=True).strip()})
        with (workspace/'stdout.jsonl').open('w') as stdout, (workspace/'stderr.txt').open('w') as stderr:
            process = subprocess.Popen(command, env=env, cwd=cwd, stdin=subprocess.PIPE, stdout=stdout, stderr=stderr, text=True)
            try:
                process.stdin.write(json.dumps({'id':'duty-proof','type':'prompt','message':'/startup-native-read-proof' if args.scenario=='raw' else '/startup-monitor-proof'})+'\n')
                process.stdin.flush()
                deadline = time.monotonic()+45
                while not (workspace/'report.json').exists() and process.poll() is None and time.monotonic()<deadline:
                    time.sleep(0.1)
                process.stdin.close()
                exit_code = process.wait(timeout=15)
            finally:
                if process.poll() is None:
                    process.kill()
                    process.wait()
        report = json.loads((workspace/'report.json').read_text()) if (workspace/'report.json').exists() else {'status':'MISSING'}
        evidence.update({'events':[json.loads(line) for line in (workspace/'events.jsonl').read_text().splitlines()] if (workspace/'events.jsonl').exists() else [],'transcripts':{str(path):path.read_text() for path in (workspace/'profile').rglob('*.jsonl')},'report':report,'exitCode':exit_code,'stderr':(workspace/'stderr.txt').read_text(),'stdout':(workspace/'stdout.jsonl').read_text()})
        paths = [repo/'extensions/startup/index.ts', *sorted((repo/'extensions/startup/src').glob('*.ts')), Path(__file__), Path(__file__).with_name('native-duties.ts'), Path(__file__).with_name('native-adapter.ts')]
        paths += [Path(__file__).with_name('probe_workspace.py'), *sorted((repo/'skills').glob('startup*/**/*.md'))]
        evidence['sourceHashes'] = {str(path.relative_to(repo)):hashlib.sha256(path.read_bytes()).hexdigest() for path in paths}
        results = report.get('results', [])
        evidence['checks'] = {'complete': report['status']=='COMPLETE' and exit_code==0, 'five_raw_reads':len(results)==5, 'raw_display':len(results)==5 and all(json.loads(result['details']['displayContent']['text'])=={'healthy':True} for result in results), 'complete_metadata':len(results)==5 and all(result['details']['fileSize']==17 and result['details']['totalLines']==2 and result['details']['displayContent']['startLine']==1 for result in results)}
        if args.scenario!='raw':
            evidence['checks']={'complete':report['status']=='COMPLETE' and exit_code==0,'root_transcript':bool(report.get('rootFile'))}
            if args.scenario=='monitor' and report['status']=='COMPLETE':
                kinds={entry['kind']:entry for entry in report['snapshots']}
                evidence['checks'].update({'quiet':kinds['quiet']['providersBefore']==kinds['quiet']['providersAfter'],'later_employee_wake':kinds['transition']['providerCount']>kinds['quiet']['providersAfter'],'repair_verified':kinds['repair']['repaired']['details']['state']=='released','uncertain_not_replayed':kinds['uncertain']['uncertain']['state']=='reconciliation' and 'never replay' in kinds['uncertain']['replay'],'fresh_reconciliation':kinds['uncertain']['reconciled']['state']=='released','returned_to_duty':report['final']['duties'][0]['lastObservation']['observation']['status']=='healthy'})
            if args.scenario=='resume' and report['status']=='COMPLETE':
                first=report['snapshots'][0]['status']['duties'][0]
                last=report['final']['duties'][0]
                evidence['checks'].update({'same_root':report['rootSession']==evidence['previous']['rootSession'],'staff_retained':report['employee']['id']==evidence['previous']['employee']['id'],'no_false_initial_health':first['currentHealth']=='unknown','new_owner_observation':last['lastObservation']['ownerEpoch']>=2})
        projections=[message['content'] for row in evidence['events'] if row['kind']=='provider' for message in row['context']['messages'] if message['role']=='developer' and isinstance(message['content'],str) and message['content'].startswith('STARTUP_BINDING=')]
        if args.scenario != 'raw':
            evidence['checks']['canonicalSources']=bool(projections) and all((repo/'skills/startup-loop/SKILL.md').read_text() in text and any((repo/'skills'/f'startup-role-{role}'/'SKILL.md').read_text() in text for role in ['manager','devops']) for text in projections)
        evidence['status'] = 'PASS' if all(evidence['checks'].values()) else 'FAIL'
        return 0 if evidence['status']=='PASS' else 1
    except BaseException as error:
        evidence['failure'] = {'kind':type(error).__name__,'message':str(error)}
        raise
    finally:
        save()
        print(json.dumps({key: value for key,value in evidence.items() if key in {'status','checks','failure','stderr'}}, indent=2))

if __name__ == '__main__':
    raise SystemExit(main())
