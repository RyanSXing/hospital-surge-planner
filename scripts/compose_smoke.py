"""Exercise local Compose login, synthetic run, replay and export; save measured evidence."""
import httpx,json,time,io,zipfile,os
from pathlib import Path
from dotenv import dotenv_values
root=Path(__file__).resolve().parents[1];env=dotenv_values(root/'.env')
c=httpx.Client(base_url='http://127.0.0.1:8080',timeout=45)
def request(method,path,**kw):
 r=c.request(method,'/api'+path,**kw);r.raise_for_status();return r.json()
ready=request('GET','/health/ready')
request('POST','/auth/login',json={'username':'admin','password':env['ADMIN_PASSWORD']})
summary=request('GET','/workspaces/workspace-main/summary');dataset=summary['dataset']
scenario=request('POST','/scenarios',json={'name':'Compose verification '+str(time.time()),'dataset_version_id':dataset['id'],'horizon_calendar_days':1,'replications':2})
run=request('POST','/run-groups',json={'scenario_id':scenario['id']});started=time.monotonic()
while run['status'] not in ('SUCCEEDED','FAILED','CANCELLED'):
 time.sleep(1);run=request('GET','/run-groups/'+run['id'])
 if time.monotonic()-started>90:raise TimeoutError(run)
assert run['status']=='SUCCEEDED',run
selected=run['selected_replication_id'];state=request('GET',f'/runs/{selected}/state',params={'at':scenario['start_at']})
metrics=request('GET',f'/run-groups/{run["id"]}/metrics')
export=request('POST','/exports',json={'run_group_id':run['id'],'format':'zip'})
while export['status'] not in ('SUCCEEDED','FAILED','CANCELLED'):
 time.sleep(1);export=request('GET','/exports/'+export['id'])
assert export['status']=='SUCCEEDED',export
r=c.get(export['download_url']);r.raise_for_status();archive=zipfile.ZipFile(io.BytesIO(r.content));names=archive.namelist()
record={'recorded_at':__import__('datetime').datetime.now(__import__('datetime').timezone.utc).isoformat(),'environment':'local Docker Desktop arm64, PostgreSQL17, Redis7, RQ worker, nginx','health':ready,'run_group_id':run['id'],'status':run['status'],'replications':2,'horizon_days':1,'elapsed_seconds':time.monotonic()-started,'selected_patients_at_start':len(state['patients']),'export_files':names,'checksums_present':'checksums.json' in names}
(root/'evidence/compose-smoke.json').write_text(json.dumps(record,indent=2)+'\n');print(json.dumps(record,indent=2))
