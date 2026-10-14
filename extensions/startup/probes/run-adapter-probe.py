#!/usr/bin/env python3
import argparse
import gzip
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import time


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--workspace', type=Path, required=True)
    parser.add_argument('--evidence', type=Path, required=True)
    parser.add_argument('--scenario', choices=['full','refresh','input','capacity'], required=True)
    args = parser.parse_args()
    evidence = {'version':1,'status':'FAIL','checks':{},'failure':None}
    def save():
        args.evidence.parent.mkdir(parents=True, exist_ok=True)
        temporary=args.evidence.with_name(args.evidence.name+'.tmp')
        with gzip.open(temporary,'wt') as target:
            json.dump(evidence,target)
        os.replace(temporary,args.evidence)
    save()
    try:
        return run(args,evidence)
    except Exception as error:
        evidence['failure']={'kind':type(error).__name__,'message':str(error)}
        raise
    finally:
        save()
        print(json.dumps({'status':evidence['status'],'checks':evidence['checks'],'reportStatus':evidence.get('report',{}).get('status'),'error':evidence['failure'] or evidence.get('report',{}).get('error'),'stderr':evidence.get('stderr'),'evidence':str(args.evidence)},indent=2))


def run(args, evidence) -> int:
    repo = Path(__file__).resolve().parents[3]
    source_paths=[repo/'extensions/startup/index.ts',*sorted((repo/'extensions/startup/src').glob('*.ts')),Path(__file__).with_name('native-adapter.ts'),Path(__file__)]
    evidence['sourceHashes']={str(path.relative_to(repo)):hashlib.sha256(path.read_bytes()).hexdigest() for path in source_paths}
    workspace = args.workspace.resolve()
    if not workspace.is_relative_to(repo / '.superpowers/sdd/2026-10-13-startup-v6/native-scratch'):
        raise ValueError('Adapter proof must remain under the isolated plan scratch')
    workspace.mkdir(parents=True, exist_ok=False)
    cwd = workspace / 'cwd'
    cwd.mkdir()
    sources = workspace / 'fixture-canonical'
    for role in ['manager', 'devops', 'architect', 'qa', 'dev', 'pa']:
        path = sources / 'skills' / f'startup-role-{role}' / 'SKILL.md'
        path.parent.mkdir(parents=True)
        path.write_text(f'---\nname: startup-role-{role}\n---\nComplete isolated canonical {role} fixture source.\n')
    loop = sources / 'skills/startup-loop/SKILL.md'
    loop.parent.mkdir(parents=True)
    loop.write_text('---\nname: startup-loop\n---\nComplete isolated canonical shared loop fixture. Remain employed and accept later durable inbox cues.\n')
    config = workspace / 'config.yml'
    config.write_text('task:\n  batch: true\n  agentIdleTtlMs: 0\n  speculativeLaunch: false\n  enableEffort: true\n  isolation:\n    enabled: true\nasync:\n  enabled: true\nproviders:\n  cacheWarming: false\nmemories:\n  enabled: false\nmcp:\n  enableProjectConfig: false\n')
    env = {key: value for key, value in os.environ.items() if key in {'PATH','HOME','TMPDIR','LANG','LC_ALL','TERM','SHELL','USER','LOGNAME'}}
    env.update({'PI_CODING_AGENT_DIR': str(workspace / 'profile'), 'STARTUP_NAME': 'adapter-proof', 'JP_SKILLS_HOME': str(workspace / 'home'), 'STARTUP_SKILLS_ROOT': str(sources), 'STARTUP_ADAPTER_HOME': str(workspace / 'home'), 'STARTUP_ADAPTER_SOURCES': str(sources), 'STARTUP_ADAPTER_EVENTS': str(workspace / 'events.jsonl'), 'STARTUP_ADAPTER_REPORT': str(workspace / 'report.json'), 'STARTUP_ADAPTER_DENIED_PATH': str(cwd / 'stale-denied.txt')})
    if args.scenario=='capacity':
        env.update({'STARTUP_EXECUTION_LIMIT':'1','STARTUP_ADAPTER_CAPACITY_RELEASE':str(workspace/'capacity-release')})
    omp = shutil.which('omp')
    if omp is None:
        raise FileNotFoundError('Installed compiled OMP is required')
    command = [omp,'--mode','rpc','--no-ui','--cwd',str(cwd),'--config',str(config),'--no-extensions','--no-skills','--no-rules','--no-lsp','--no-pty','--no-title','--tools','task,read,write','--extension',str(Path(__file__).parents[1] / 'index.ts'),'--extension',str(Path(__file__).with_name('native-adapter.ts')),'--model','startup-adapter/offline','--thinking','off','--auto-approve']
    evidence.update({'command': command, 'installedVersion': subprocess.check_output([omp,'--version'],text=True).strip()})
    with (workspace / 'stdout.jsonl').open('w') as stdout, (workspace / 'stderr.txt').open('w') as stderr:
        process = subprocess.Popen(command,env=env,cwd=cwd,stdin=subprocess.PIPE,stdout=stdout,stderr=stderr,text=True)
        try:
            if args.scenario=='input':
                for number in range(100):
                    process.stdin.write(json.dumps({'id':f'history-{number}','type':'prompt','message':'/startup-fixture-status HISTORY_BLOB '+('retained '*512)})+'\n')
                process.stdin.flush()
                for number,message in enumerate(['status fixture input','also investigate fixture '+('LONG_INTAKE_SEGMENT '*1024)+'LONG_INTAKE_TAIL']):
                    process.stdin.write(json.dumps({'id':f'input-{number}','type':'prompt','message':message,'images':[] if number==0 else [{'type':'image','mimeType':'image/png','data':'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII='}]})+'\n')
                    process.stdin.flush()
                    deadline=time.monotonic()+35
                    while process.poll() is None and time.monotonic()<deadline:
                        path=workspace/'events.jsonl'
                        records=[json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []
                        routes=[record for record in records if record['kind']=='tool' and record['name']=='startup_route' and not record['error']]
                        stops=sum(record['kind']=='native-root-stop' for record in records)
                        if len(routes)>number and stops>=2*(number+1):
                            time.sleep(0.5)
                            break
                        time.sleep(0.1)
                    else:
                        raise RuntimeError('Actual human input did not route and finish')
                process.stdin.write(json.dumps({'id':'input-report','type':'prompt','message':'/startup-input-proof-report'})+'\n')
            else:
                process.stdin.write(json.dumps({'id':'adapter-proof','type':'prompt','message':'/startup-capacity-proof' if args.scenario=='capacity' else '/startup-adapter-refresh-proof' if args.scenario=='refresh' else '/startup-adapter-proof'})+'\n')
            process.stdin.flush()
            deadline=time.monotonic()+110
            while not (workspace/'report.json').exists() and process.poll() is None and time.monotonic()<deadline:
                time.sleep(0.1)
            if not (workspace/'report.json').exists() and process.poll() is None:
                process.terminate()
            process.stdin.close()
            try:
                exit_code=process.wait(timeout=15)
            except subprocess.TimeoutExpired:
                process.kill()
                exit_code=process.wait()
        finally:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
            evidence.update({'exitCode':process.returncode,'stderr':(workspace/'stderr.txt').read_text(),'stdout':(workspace/'stdout.jsonl').read_text()})
    events=[json.loads(line) for line in (workspace/'events.jsonl').read_text().splitlines()] if (workspace/'events.jsonl').exists() else []
    report=json.loads((workspace/'report.json').read_text()) if (workspace/'report.json').exists() else {'status':'FAIL','error':'No native adapter report'}
    evidence.update({'report':report,'events':events,'exitCode':exit_code,'stderr':(workspace/'stderr.txt').read_text(),'stdout':(workspace/'stdout.jsonl').read_text()})
    checks={}
    if report['status']=='COMPLETE' and args.scenario=='capacity':
        proof=next(event for event in events if event['kind']=='native-capacity-proof')
        checks={'native_completion':exit_code==0,'native32_explicit1':proof['blocked']['capacity']['nativeLimit']==32 and proof['blocked']['capacity']['explicitLimit']==1,'idle_wakes_blocked':all(proof['blocked']['deliveries'][key]['kind']=='capacity-blocked' for key in ['capacity-blocked-one','capacity-blocked-two']),'running_injection_accepted':proof['blocked']['deliveries']['capacity-injected']['outcome']=='injected','aggregate_native_turn_limit':bool(proof['activeCounts']) and max(proof['activeCounts'])<=1,'pending_cues_resume':any(employee['checkpoint'] and employee['checkpoint'].get('assignment')=='capacity-blocked-two' for employee in proof['final']['employees']),'ordinary_running_helper_denied':any(event['kind']=='provider' and any(message['role']=='toolResult' and message.get('toolCallId')=='fixture-capacity-helper' and message.get('isError') and 'capacity' in str(message['content']) for message in event['context']['messages']) for event in events),'ordinary_batch_count_bounded':proof['batch']['rejected'],'native_rejection_releases_slot':'does-not-exist' in json.dumps(proof['rejected']) and proof['afterRejected']['capacity']['available']==1,'blocked_retry_no_provider_spin':proof['providersBeforeRetry']==proof['providersAfterRetry']}
    if report['status']=='COMPLETE' and args.scenario=='input':
        proof=next(event for event in events if event['kind']=='native-input-proof')
        initial=proof['initial']
        inputs=[event['details'] for event in events if event['kind']=='tool' and event['name']=='startup_route' and not event['error']]
        status=next(receipt for receipt in inputs if receipt['textPreview']=='status fixture input')
        work=next(receipt for receipt in inputs if receipt['textPreview'].startswith('also investigate fixture'))
        providers=[event['context'] for event in events if event['kind']=='provider']
        denied=[message for context in providers for message in context['messages'] if message['role']=='toolResult' and message.get('isError') and message.get('toolCallId','').startswith('fixture-input-read') and 'Route received input' in str(message['content'])]
        guards=[message for context in providers for message in context['messages'] if 'Route received input' in str(message.get('content')) and message['role']!='toolResult']
        checks={'native_completion':exit_code==0,'human_input_captured_before_lookup':len(denied)>=2,'no_idle_with_unrouted_input':bool(guards),'status_routed_without_work':status['disposition']['kind']=='status' and all(team['eventId']!=status['id'] for team in initial['teams']),'additional_input_fresh_complete_team':work['disposition']['kind']=='work' and any(team['eventId']==work['id'] and team['state']=='active' and len(team['devs'])==1 for team in initial['teams']),'registered_command_control_receipt':any(event['kind']=='native-input' and event['text']=='/startup-input-proof-report' for event in events) and initial['inputCounts']['unclassified']==0,'internal_manager_wake_excluded':any('Fixture internal wake exclusion' in str(context['messages']) for context in providers) and initial['inputs']==proof['after']['inputs'] and initial['inputCounts']==proof['after']['inputCounts'],'bounded_history_and_projection':initial['inputCounts']['total']==103 and 'HISTORY_BLOB' not in json.dumps(initial) and len(json.dumps(initial))<24000 and all('iVBORw0KGgo' not in message['content'] for context in providers for message in context['messages'] if message['role']=='developer' and isinstance(message['content'],str)),'scoped_native_image_retrieval':any(message['role']=='toolResult' and message.get('toolName')=='startup_image' and not message.get('isError') and any(part.get('type')=='image' and part.get('mimeType')=='image/png' for part in message['content']) for context in providers for message in context['messages'])}
        architect_ids={team['architect'] for team in initial['teams']}
        claimed_contexts=[]
        for context in providers:
            projection=next((message['content'] for message in context['messages'] if message['role']=='developer' and isinstance(message['content'],str) and message['content'].startswith('STARTUP_BINDING=')),None)
            if projection is None or json.loads(projection.split('\n')[0].removeprefix('STARTUP_BINDING='))['employeeId'] not in architect_ids:
                continue
            if any(message['role']=='toolResult' and message.get('toolName')=='startup_claim' and 'architect-intake' in json.dumps(message['content']) for message in context['messages']):
                claimed_contexts.append(context)
        non_image_text=[message['content'] if isinstance(message['content'],str) else part.get('text','') for context in claimed_contexts for message in context['messages'] for part in ([{}] if isinstance(message['content'],str) else message['content']) if isinstance(message['content'],str) or part.get('type')=='text']
        claimed_intakes=[event['details']['message'] for event in events if event['kind']=='tool' and event.get('name')=='startup_claim' and not event.get('error') and event.get('details') and event['details']['message']['payload'].get('kind')=='architect-intake']
        checks['claimed_intake_text_bounded']=bool(claimed_contexts) and bool(claimed_intakes) and work['textLength']>16384 and all('iVBORw0KGgo' not in text and 'LONG_INTAKE_TAIL' not in text for text in non_image_text) and all(message['payload']['raw']['textLength']>16384 and len(message['payload']['raw']['textPreview'])<=512 and message['payload']['raw']['textTool']=='startup_input' and message['payload']['raw']['attachments'][0]['tool']=='startup_image' for message in claimed_intakes)
    if report['status']=='COMPLETE' and args.scenario=='refresh':
        refreshed=next(event for event in events if event['kind']=='native-refresh')
        providers=[event['context'] for event in events if event['kind']=='provider']
        projections=[message['content'] for context in providers for message in context['messages'] if message['role']=='developer' and isinstance(message['content'],str) and message['content'].startswith('STARTUP_BINDING=')]
        current=refreshed['current']
        original=refreshed['original']
        checks={'native_completion':exit_code==0,'fresh_actual_native_context':current['generation']==2 and current['nativeHandle']!=original['nativeHandle'] and json.loads(current['nativeHandle'])['sessionId']!=json.loads(original['nativeHandle'])['sessionId'],'full_new_source_in_provider':any(refreshed['newText'] in text and loop.read_text() in text for text in projections),'preserved_unclaimed_mail_processed':current['checkpoint']['assignment']=='refresh-saved-mail','old_native_context_fenced':not (cwd/'stale-denied.txt').exists() and any(message['role']=='toolResult' and message.get('toolName')=='write' and message.get('isError') and message.get('toolCallId','').startswith('fixture-stale-write') and 'superseded' in str(message['content']) for context in providers for message in context['messages'])}
    if report['status']=='COMPLETE' and args.scenario=='full':
        kinds={event['kind']:event for event in events if event['kind']!='provider'}
        replay=kinds['replay']['result']['details']
        staff=kinds['final-staff']['result']['details']
        providers=[event['context'] for event in events if event['kind']=='provider']
        children=report['children']
        projected=[message['content'] for context in providers for message in context['messages'] if message['role']=='developer' and isinstance(message['content'],str) and message['content'].startswith('STARTUP_BINDING=')]
        def complete_projection(text):
            marker=json.loads(text.split('\n')[0].removeprefix('STARTUP_BINDING='))
            employee=next(entry for entry in staff['employees'] if entry['id']==marker['employeeId'])
            return Path(employee['source']['rolePath']).read_text() in text and loop.read_text() in text
        checks={'native_completion':exit_code==0,'existing_plus_six_ready':replay['ready']==6 and replay['reserved']==6,'retry_stable_ids':kinds['six']['result']['details']['employees']==replay['employees'] or {employee['id'] for employee in kinds['six']['result']['details']['employees']}=={employee['id'] for employee in replay['employees']},'complete_provider_sources':bool(projected) and all(complete_projection(text) for text in projected),'fresh_complete_teams':len(staff['teams'])==2 and all(team['state']=='active' for team in staff['teams']) and len({member for team in staff['teams'] for member in [team['architect'],team['qa'],*team['devs']]})==6,'source_loaded_native_bindings':sum(employee['nativeHandle'] is not None for employee in staff['employees'])==14,'parked_durable_wake':kinds['wake']['result']['details']['id']=='later-assignment' and any('own second assignment' in text for text in projected),'ordinary_compatibility':len(kinds['ordinary']['result']['details']['progress'])==1,'ordinary_native_rejection':'does-not-exist' in json.dumps(kinds['ordinary-rejected']),'aborted_native_manager_wake':kinds['manager-idle-before-abort']['providerStreaming'] is False and kinds['manager-idle-before-abort']['queuedMessages'] is False and kinds['aborted-manager-wake']['sessionNull'] and kinds['aborted-manager-wake']['managerCheckpoint']['assignment']==kinds['aborted-manager-wake']['alertId'] and kinds['aborted-manager-wake']['delivery']['kind']=='manager-notification-attempt','parent_specific_default_agent':bool(kinds['ordinary-parent-default']['refs']) and any(event['kind']=='tool' and event['id']=='default-parent' and event['name']=='task' and any(progress.get('agent')=='scout' for progress in event.get('details',{}).get('progress',[])) for event in events) and any('NATIVE_DEFAULT_AGENT_PROBE' in str(context.get('systemPrompt')) and any(tool['name']=='task' and 'scout' in json.dumps(tool['parameters']) for tool in context.get('tools',[])) for context in providers),'root_transcript_correlation':len(children)==15 and all(next(json.loads(line) for line in Path(child['file']).read_text().splitlines() if json.loads(line).get('type')=='session')['parentSession']==kinds['root']['file'] for child in children)}
    if report['status']=='COMPLETE' and args.scenario=='full':
        transitions=[event['details'] for event in events if event['kind']=='tool' and event.get('name')=='startup_item' and not event.get('error')]
        checks['canonical_native_item_phases']=all([entry['status'] for entry in transitions if entry['request']['itemId']==item]==['EXECUTING','REVIEW','REVIEW','REVIEW','READY_TO_LAND','DONE'] for item in ['item-first-event','item-second-event'])
        checks['native_item_role_hierarchy']=all(next(employee['role'] for employee in staff['employees'] if employee['id']==entry['actorId'])=={'assign':'architect','review':'dev','qa_assign':'architect','qa':'qa','gate':'architect','decide':'manager'}[entry['request']['action']] for entry in transitions)
    evidence['checks']=checks
    evidence['status']='PASS' if checks and all(checks.values()) else 'FAIL'
    return 0 if evidence['status']=='PASS' else 1

if __name__ == '__main__':
    raise SystemExit(main())
