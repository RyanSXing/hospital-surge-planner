"""Read-only exact-image pool comparison; temporary inputs only, no artifact/job writes."""
import argparse,hashlib,json,os,statistics,tempfile,time
from pathlib import Path
from types import SimpleNamespace

_ready_at=None
_init_seconds=None

def initialize(path,stop):
    global _ready_at,_init_seconds
    start=time.perf_counter()
    from surge_api.worker import _replication_file_initializer
    _replication_file_initializer(path,stop)
    _init_seconds=time.perf_counter()-start
    _ready_at=time.perf_counter()

def thread_count():
    return int(next(line.split(':')[1] for line in Path('/proc/self/status').read_text().splitlines() if line.startswith('Threads:')))

def compute(index,barrier):
    from surge_api.worker import _replication_task
    own=Path(barrier)/('ready-'+str(os.getpid()));own.touch(mode=0o600)
    deadline=time.monotonic()+120
    while len(list(Path(barrier).glob('ready-*')))<8:
        if time.monotonic()>deadline:raise TimeoutError('Eight-child readiness barrier timed out')
        time.sleep(.01)
    data=_replication_task(index)
    return {'result':data,'pid':os.getpid(),'ready_at':_ready_at,'init_seconds':_init_seconds,'threads':thread_count()}

def model_hash(data):
    data={key:value for key,value in data.items() if key!='execution_metrics'}
    return hashlib.sha256(json.dumps(data,sort_keys=True,separators=(',',':'),allow_nan=False).encode()).hexdigest()

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--job-id',required=True);parser.add_argument('--mode',choices=['default','cap1'],required=True);args=parser.parse_args()
    # This script runs in a fresh exec process; importing numerical libraries
    # happens only after the diagnostic environment is selected.
    cap_keys=('OPENBLAS_NUM_THREADS','OMP_NUM_THREADS','MKL_NUM_THREADS')
    production={key:os.environ.get(key) for key in cap_keys}
    if args.mode=='cap1':
        for key in cap_keys:os.environ[key]='1'
    start=time.perf_counter()
    import surge_api.worker as worker
    from surge_api.db import Document,Job,digest,make_database
    from surge_engine import aggregate_results
    from surge_engine.aggregate import representative_replication
    import_seconds=time.perf_counter()-start
    began=time.perf_counter();engine,Session=make_database()
    with Session() as session:
        job=session.get(Job,args.job_id);assert job and job.status=='SUCCEEDED'
        scenario=job.payload['scenario'];dataset=session.get(Document,job.payload['dataset_version_id']).data
        expected=job.payload['input_sha256'];manifest=job.result['manifest']
    engine.dispose();load_seconds=time.perf_counter()-began
    began=time.perf_counter();assert digest({'dataset':dataset,'scenario':scenario})==expected;digest_seconds=time.perf_counter()-began
    worker._replication_file_initializer=initialize
    with tempfile.TemporaryDirectory(prefix='hsp-probe-barrier-') as barrier:
        started=time.perf_counter();cpu=time.process_time()
        with worker.private_replication_pool(dataset,scenario,8,SimpleNamespace(attempt=1)) as pool:
            records=[f.result(timeout=180) for f in [pool.submit(compute,index,barrier) for index in range(8)]]
            replication_end=time.perf_counter()
            results=[row['result'] for row in records]
            selected=representative_replication(results)['replication_index']
            trace_future=pool.submit(worker._selected_trace_task,selected)
            aggregate_start=time.perf_counter();aggregate=aggregate_results(results,scenario=scenario);aggregation_seconds=time.perf_counter()-aggregate_start
            trace=trace_future.result(timeout=180)
            outputs_done=time.perf_counter()
        total=time.perf_counter()-started
    report={'mode':args.mode,'code_commit':os.environ.get('CODE_COMMIT'),'source_job':args.job_id,'input_sha256':expected,'generator_version':manifest['generator_version'],'model_version':manifest['model_version'],'production_thread_environment':production,'effective_thread_environment':{key:os.environ.get(key) for key in cap_keys},'worker_import_seconds':import_seconds,'read_only_database_load_seconds':load_seconds,'frozen_input_digest_seconds':digest_seconds,'readiness_seconds':max(row['ready_at'] for row in records)-started,'eight_replications_seconds':replication_end-started,'aggregation_seconds':aggregation_seconds,'overlapped_trace_and_aggregate_seconds':outputs_done-replication_end,'total_pool_seconds':total,'parent_cpu_seconds':time.process_time()-cpu,'distinct_children':len({row['pid'] for row in records}),'parent_threads':thread_count(),'replication_sha256':[model_hash(row) for row in results],'aggregate_sha256':model_hash(aggregate),'selected_trace_sha256':model_hash(trace),'selected_replication_index':selected,'selected_trace_execution_metrics':trace['execution_metrics'],'children':[{key:value for key,value in row.items() if key!='result'}|{'execution_metrics':row['result']['execution_metrics']} for row in records]}
    print(json.dumps(report),flush=True)
if __name__=='__main__':main()
