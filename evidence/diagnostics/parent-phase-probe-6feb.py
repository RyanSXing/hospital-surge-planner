"""Read-only serial phase probe; strict fake PUT transport forbids object writes."""
import argparse,copy,gc,gzip,hashlib,importlib,json,os,resource,time
from datetime import datetime,UTC

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--job-id',required=True);args=parser.parse_args()
    from sqlalchemy import text
    from surge_api.db import Document,Job,canonical,digest,make_database
    from surge_api.artifacts import ArtifactStore
    from surge_api.comparisons import compact_summary
    from surge_api.worker import period_aggregation
    from surge_engine import aggregate_results
    resource.setrlimit(resource.RLIMIT_AS,(10*2**30,10*2**30))
    phases=[]
    def measured(name,action):
        wall=time.perf_counter();cpu=time.process_time();value=action()
        phases.append({'phase':name,'wall_seconds':time.perf_counter()-wall,'cpu_seconds':time.process_time()-cpu})
        return value
    def load():
        engine,Session=make_database()
        with Session() as session:
            session.execute(text('SET TRANSACTION READ ONLY'))
            job=session.get(Job,args.job_id);assert job and job.status=='SUCCEEDED'
            data=session.get(Document,job.payload['dataset_version_id']).data
            result=(data,job.payload,job.result)
        engine.dispose();return result
    dataset,payload,saved=measured('database_load_exact_frozen_inputs',load)
    payload=measured('deepcopy_payload',lambda:copy.deepcopy(payload))
    dataset=measured('deepcopy_dataset',lambda:copy.deepcopy(dataset))
    scenario=payload['scenario']
    actual=measured('frozen_input_digest',lambda:digest({'dataset':dataset,'scenario':scenario}));assert actual==payload['input_sha256']
    measured('cold_import_oci_sdk',lambda:importlib.import_module('oci'))
    store=measured('cold_oci_client_and_instance_signer',ArtifactStore)
    measured('warm_oci_store_construction',ArtifactStore)
    reps=measured('diagnostic_read_replicates_not_fresh_job_cost',lambda:store.get_json(saved['replications_artifact']))
    aggregate=measured('aggregate_results',lambda:aggregate_results(reps,scenario=scenario))
    aggregate['comparison_summary']=measured('compact_summary',lambda:compact_summary(reps))
    aggregate['periods']={grain:measured('period_'+grain,lambda grain=grain:period_aggregation(reps,grain)) for grain in ['week','month']}
    expected=store.get_json(saved['aggregate_artifact']);assert digest(aggregate)==digest(expected)
    trace_meta=next(a for a in saved['manifest']['artifacts'] if a['name']=='selected-trace.json.gz')
    trace=measured('diagnostic_read_trace_not_fresh_job_cost',lambda:store.get_json(trace_meta))
    # Only the read client above can contact OCI. The write adapter below has a
    # strict dummy client whose sole method is put_object; no real transport.
    class NoNetworkPut:
        calls=0;bytes=0
        def put_object(self,namespace,bucket,key,data,**kwargs):
            self.calls+=1;self.bytes+=len(data)
    local_store=object.__new__(ArtifactStore);local_store.backend='oci';local_store.client=NoNetworkPut();local_store.namespace='diagnostic';local_store.bucket='diagnostic'
    rows=[]
    def encode(name,value,metadata=None):
        raw=measured(name+'_canonical',lambda:canonical(value));packed=measured(name+'_gzip6',lambda:gzip.compress(raw,compresslevel=6,mtime=0))
        generated=measured(name+'_sha_md5_metadata_no_network',lambda:local_store.write('workspace-main',args.job_id,name+'.json.gz',packed,'application/gzip'))
        matches=metadata is None or generated['sha256']==metadata['sha256']
        assert matches,(name,'compressed bytes differ')
        rows.append({'name':name,'raw_bytes':len(raw),'packed_bytes':len(packed),'sha256':generated['sha256'],'matches_saved':metadata is not None and matches})
    def per_rep():
        for index,row in enumerate(reps):local_store.put_json('workspace-main',args.job_id,'replication-'+str(index),row)
    measured('per_replication_canonical_gzip_sha_md5_metadata_no_network',per_rep)
    encode('aggregate',aggregate,saved['aggregate_artifact'])
    encode('replications',reps,saved['replications_artifact'])
    encode('inputs',{'dataset':dataset,'scenario':scenario},saved['inputs_artifact'])
    encode('selected_trace',trace,trace_meta)
    report={'recorded_at':datetime.now(UTC).isoformat(),'scope':'Exact completed current-input read-only serial phases; all PUTs replaced by a strict no-network stub; no jobs/objects written','code_commit':os.environ.get('CODE_COMMIT'),'run_group_id':args.job_id,'replications':len(reps),'days':scenario['horizon_calendar_days'],'input_sha256':actual,'aggregate_exact':True,'phases':phases,'artifacts':rows,'put_preparation_calls':local_store.client.calls,'put_preparation_bytes':local_store.client.bytes,'actual_put_network_latency_measured':False,'peak_rss_bytes':resource.getrusage(resource.RUSAGE_SELF).ru_maxrss*1024,'limits':['Single diagnostic trial, not end-to-end acceptance.','Artifact reload/decode is diagnostic setup and not a fresh-run cost.','Actual OCI PUT network latency and durable per-replication SQL publication are unmeasured.','Cold OCI SDK import and client authentication are separated, while real worker construction includes both.']}
    print(json.dumps(report),flush=True)
if __name__=='__main__':main()
