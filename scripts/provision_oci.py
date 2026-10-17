"""Idempotently provision only the approved single-host Hospital Surge Planner demo."""
from __future__ import annotations
import argparse
import base64
from datetime import datetime, timezone
import json
from pathlib import Path
import time
import oci

ROOT = Path(__file__).resolve().parents[1]
STATE = ROOT / 'data/deployment/oci-resources.json'
COMPARTMENT = 'ocid1.compartment.oc1..aaaaaaaazomfb4gxuso6rhfrkyh2fgtfmjpms7b33tnymkcn74q2qb4hstzq'
IMAGE = 'ocid1.image.oc1.us-chicago-1.aaaaaaaadcv3pphkgnnwsulixcq3glryb4ljkgxnijfocsxarbg6fnru5sjq'
TAGS = {'project': 'hospital-surge-planner', 'environment': 'demo', 'budget_monthly_usd': '83'}
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--apply', action='store_true')
parser.add_argument('--ssh-source', required=True, help='Verified workstation IPv4 CIDR from OCI audit logs')
parser.add_argument('--shape', choices=['VM.Standard.A1.Flex', 'VM.Standard.A2.Flex'], default='VM.Standard.A1.Flex')
args = parser.parse_args()
if not args.apply:
    raise SystemExit('Use --apply only for the approved eight-vCPU/16-GiB deployment.')
import ipaddress
if ipaddress.ip_network(args.ssh_source).prefixlen != 32:
    raise SystemExit('SSH source must be one verified IPv4 address (/32).')
config = oci.config.from_file(profile_name='CODEX_API_KEY')
if config['region'] != 'us-chicago-1':
    raise SystemExit('Approved region is us-chicago-1.')
net = oci.core.VirtualNetworkClient(config)
compute = oci.core.ComputeClient(config)
block = oci.core.BlockstorageClient(config)
identity = oci.identity.IdentityClient(config)
storage = oci.object_storage.ObjectStorageClient(config)
state = json.loads(STATE.read_text()) if STATE.exists() else {'compartment_id': COMPARTMENT, 'region': config['region']}

def save(key, value):
    state[key] = value
    state['updated_at'] = datetime.now(timezone.utc).isoformat()
    STATE.write_text(json.dumps(state, indent=2)+'\n'); STATE.chmod(0o600)
    print(key+': '+str(value), flush=True)

def find(rows, name):
    return next((r for r in rows if getattr(r,'display_name',getattr(r,'name',None)) == name and getattr(r,'lifecycle_state','AVAILABLE') not in ['TERMINATED','TERMINATING','DELETED','DELETING']), None)

def wait(get, expected='AVAILABLE'):
    for _ in range(90):
        row=get().data
        if row.lifecycle_state == expected:
            return row
        if row.lifecycle_state in ['TERMINATED','FAULTY','FAILED']:
            raise RuntimeError('Resource reached '+row.lifecycle_state)
        time.sleep(5)
    raise TimeoutError('Resource did not reach '+expected)

def allrows(method, *a, **kw):
    return oci.pagination.list_call_get_all_results(method,*a,**kw).data

vcn=find(allrows(net.list_vcns,COMPARTMENT),'hospital-surge-vcn')
if not vcn:
    vcn=net.create_vcn(oci.core.models.CreateVcnDetails(compartment_id=COMPARTMENT,display_name='hospital-surge-vcn',cidr_blocks=['10.42.0.0/16'],dns_label='hospitalsurge',freeform_tags=TAGS)).data
save('vcn_id',vcn.id);wait(lambda:net.get_vcn(vcn.id))
gateway=find(allrows(net.list_internet_gateways,COMPARTMENT,vcn_id=vcn.id),'hospital-surge-internet')
if not gateway:
    gateway=net.create_internet_gateway(oci.core.models.CreateInternetGatewayDetails(compartment_id=COMPARTMENT,vcn_id=vcn.id,display_name='hospital-surge-internet',is_enabled=True,freeform_tags=TAGS)).data
save('gateway_id',gateway.id)
route=find(allrows(net.list_route_tables,COMPARTMENT,vcn_id=vcn.id),'hospital-surge-route')
if not route:
    route=net.create_route_table(oci.core.models.CreateRouteTableDetails(compartment_id=COMPARTMENT,vcn_id=vcn.id,display_name='hospital-surge-route',route_rules=[oci.core.models.RouteRule(destination='0.0.0.0/0',destination_type='CIDR_BLOCK',network_entity_id=gateway.id)],freeform_tags=TAGS)).data
save('route_table_id',route.id)

def tcp(port): return oci.core.models.TcpOptions(destination_port_range=oci.core.models.PortRange(min=port,max=port))
ingress=[oci.core.models.IngressSecurityRule(protocol='6',source='0.0.0.0/0',tcp_options=tcp(443),description='Public authenticated HTTPS'),oci.core.models.IngressSecurityRule(protocol='6',source=args.ssh_source,tcp_options=tcp(22),description='Verified deployment workstation only')]
egress=[oci.core.models.EgressSecurityRule(protocol='6',destination='0.0.0.0/0',tcp_options=tcp(p),description='Package, container and OCI HTTPS/HTTP') for p in [80,443]]
for destination in ['169.254.169.254/32','10.42.0.2/32']:
    egress.append(oci.core.models.EgressSecurityRule(protocol='17',destination=destination,udp_options=oci.core.models.UdpOptions(destination_port_range=oci.core.models.PortRange(min=53,max=53)),description='VCN DNS'))
    egress.append(oci.core.models.EgressSecurityRule(protocol='6',destination=destination,tcp_options=tcp(53),description='VCN DNS TCP'))
egress.append(oci.core.models.EgressSecurityRule(protocol='17',destination='169.254.169.254/32',udp_options=oci.core.models.UdpOptions(destination_port_range=oci.core.models.PortRange(min=123,max=123)),description='OCI time service'))
security=find(allrows(net.list_security_lists,COMPARTMENT,vcn_id=vcn.id),'hospital-surge-restricted')
if not security:
    security=net.create_security_list(oci.core.models.CreateSecurityListDetails(compartment_id=COMPARTMENT,vcn_id=vcn.id,display_name='hospital-surge-restricted',ingress_security_rules=ingress,egress_security_rules=egress,freeform_tags=TAGS)).data
save('security_list_id',security.id);save('ssh_source_cidr',args.ssh_source)
subnet=find(allrows(net.list_subnets,COMPARTMENT,vcn_id=vcn.id),'hospital-surge-public')
if not subnet:
    subnet=net.create_subnet(oci.core.models.CreateSubnetDetails(compartment_id=COMPARTMENT,vcn_id=vcn.id,display_name='hospital-surge-public',cidr_block='10.42.1.0/24',dns_label='app',route_table_id=route.id,security_list_ids=[security.id],prohibit_public_ip_on_vnic=False,freeform_tags=TAGS)).data
save('subnet_id',subnet.id);wait(lambda:net.get_subnet(subnet.id))
namespace=storage.get_namespace().data;save('namespace',namespace)
for purpose in ['artifacts','backups']:
    name='hospital-surge-'+purpose
    try: bucket=storage.get_bucket(namespace,name).data
    except oci.exceptions.ServiceError as exc:
        if exc.status!=404: raise
        bucket=storage.create_bucket(namespace,oci.object_storage.models.CreateBucketDetails(name=name,compartment_id=COMPARTMENT,public_access_type='NoPublicAccess',storage_tier='Standard',freeform_tags=TAGS)).data
    if bucket.compartment_id!=COMPARTMENT or bucket.public_access_type!='NoPublicAccess':
        raise RuntimeError('Existing bucket scope/privacy does not match.')
    save(purpose+'_bucket',bucket.name)
instance=find(allrows(compute.list_instances,COMPARTMENT),'hospital-surge-demo')
if not instance:
    user_data=base64.b64encode((ROOT/'infra/cloud-init.yaml').read_bytes()).decode()
    public_key=(ROOT/'data/deployment/oci_deploy_ed25519.pub').read_text().strip()
    domains=identity.list_availability_domains(config['tenancy']).data
    for domain in domains:
        try:
            instance=compute.launch_instance(oci.core.models.LaunchInstanceDetails(compartment_id=COMPARTMENT,availability_domain=domain.name,display_name='hospital-surge-demo',shape=args.shape,shape_config=oci.core.models.LaunchInstanceShapeConfigDetails(ocpus=4 if args.shape=='VM.Standard.A2.Flex' else 8,memory_in_gbs=16),source_details=oci.core.models.InstanceSourceViaImageDetails(image_id=IMAGE,boot_volume_size_in_gbs=50,boot_volume_vpus_per_gb=10),create_vnic_details=oci.core.models.CreateVnicDetails(subnet_id=subnet.id,assign_public_ip=True,hostname_label='hospital-surge'),metadata={'ssh_authorized_keys':public_key,'user_data':user_data},instance_options=oci.core.models.InstanceOptions(are_legacy_imds_endpoints_disabled=True),freeform_tags=TAGS)).data
            break
        except oci.exceptions.ServiceError as exc:
            if exc.code not in ['OutOfHostCapacity','OutOfCapacity'] and not (exc.status==500 and 'capacity' in exc.message.lower()): raise
            print('Capacity unavailable in '+domain.name,flush=True)
    if not instance: raise RuntimeError('Approved shape has no capacity in subscribed availability domains.')
save('instance_id',instance.id);save('availability_domain',instance.availability_domain)
save('shape',instance.shape);save('ocpus',instance.shape_config.ocpus);save('memory_in_gbs',instance.shape_config.memory_in_gbs)
volume=find(allrows(block.list_volumes,compartment_id=COMPARTMENT,availability_domain=instance.availability_domain),'hospital-surge-data')
if not volume:
    volume=block.create_volume(oci.core.models.CreateVolumeDetails(compartment_id=COMPARTMENT,availability_domain=instance.availability_domain,display_name='hospital-surge-data',size_in_gbs=100,vpus_per_gb=10,freeform_tags=TAGS)).data
save('volume_id',volume.id);wait(lambda:block.get_volume(volume.id))
instance=wait(lambda:compute.get_instance(instance.id),'RUNNING')
attachments=allrows(compute.list_volume_attachments,COMPARTMENT,instance_id=instance.id)
attachment=next((a for a in attachments if a.volume_id==volume.id and a.lifecycle_state!='DETACHED'),None)
if not attachment:
    attachment=compute.attach_volume(oci.core.models.AttachParavirtualizedVolumeDetails(instance_id=instance.id,volume_id=volume.id,device='/dev/oracleoci/oraclevdb',display_name='hospital-surge-data',is_read_only=False,is_shareable=False,is_pv_encryption_in_transit_enabled=False)).data
save('volume_attachment_id',attachment.id);wait(lambda:compute.get_volume_attachment(attachment.id),'ATTACHED')
vnics=allrows(compute.list_vnic_attachments,COMPARTMENT,instance_id=instance.id)
vnic=net.get_vnic(vnics[0].vnic_id).data;save('vnic_id',vnic.id);save('public_ip',vnic.public_ip)
name='hospital-surge-instance'
group=find(allrows(identity.list_dynamic_groups,config['tenancy']),name)
if not group:
    group=identity.create_dynamic_group(oci.identity.models.CreateDynamicGroupDetails(compartment_id=config['tenancy'],name=name,description='Only the Hospital Surge Planner demo instance',matching_rule="ALL {instance.id = '"+instance.id+"'}",freeform_tags=TAGS)).data
save('dynamic_group_id',group.id)
name='hospital-surge-object-access'
policy=find(allrows(identity.list_policies,COMPARTMENT),name)
if not policy:
    condition="where any {target.bucket.name='hospital-surge-artifacts', target.bucket.name='hospital-surge-backups'}"
    statements=[f'Allow dynamic-group hospital-surge-instance to manage objects in compartment hospital-surge-planner {condition}',f'Allow dynamic-group hospital-surge-instance to read buckets in compartment hospital-surge-planner {condition}']
    policy=identity.create_policy(oci.identity.models.CreatePolicyDetails(compartment_id=COMPARTMENT,name=name,description='Bucket-specific object access for application and private backups',statements=statements,freeform_tags=TAGS)).data
save('policy_id',policy.id)
# No email notifications or external recipients are created by provisioning.
budgets=oci.budget.BudgetClient(config)
budget=find(allrows(budgets.list_budgets,config['tenancy']),'hospital-surge-monthly')
if not budget:
    budget=budgets.create_budget(oci.budget.models.CreateBudgetDetails(compartment_id=config['tenancy'],display_name='hospital-surge-monthly',description='Approved approximate monthly project envelope; budget is not a spending cap',amount=83,reset_period='MONTHLY',target_type='COMPARTMENT',targets=[COMPARTMENT],freeform_tags=TAGS)).data
save('budget_id',budget.id)
# This lifecycle applies only to database backups; application retention owns exports/traces.
name='hospital-surge-backup-lifecycle'
lifecycle_policy=find(allrows(identity.list_policies,config['tenancy']),name)
if not lifecycle_policy:
    lifecycle_policy=identity.create_policy(oci.identity.models.CreatePolicyDetails(compartment_id=config['tenancy'],name=name,description='Allow regional Object Storage to apply the seven-day backup lifecycle only',statements=["Allow service objectstorage-us-chicago-1 to manage object-family in compartment hospital-surge-planner where all {target.bucket.name='hospital-surge-backups', any {request.permission='BUCKET_INSPECT', request.permission='BUCKET_READ', request.permission='OBJECT_INSPECT', request.permission='OBJECT_DELETE', request.permission='OBJECT_VERSION_DELETE'}}"],freeform_tags=TAGS)).data
obsolete_policy=state.get('lifecycle_policy_id')
save('lifecycle_policy_id',lifecycle_policy.id)
for attempt in range(6):
    try:
        storage.put_object_lifecycle_policy(namespace,state['backups_bucket'],oci.object_storage.models.PutObjectLifecyclePolicyDetails(items=[oci.object_storage.models.ObjectLifecycleRule(name='Seven-day database backup retention',target='objects',action='DELETE',time_amount=7,time_unit='DAYS',is_enabled=True,object_name_filter=oci.object_storage.models.ObjectNameFilter(inclusion_prefixes=['backups/']))]))
        break
    except oci.exceptions.ServiceError as exc:
        if exc.code!='InsufficientServicePermissions' or attempt==5: raise
        time.sleep(10)
if obsolete_policy and obsolete_policy!=lifecycle_policy.id:
    identity.delete_policy(obsolete_policy)
save('backup_retention_days',7)
save('status','provisioned_pending_host_setup_and_application')
public={k:v for k,v in state.items() if k!='ssh_source_cidr'}
(ROOT/'evidence/oci-provisioning.json').write_text(json.dumps(public,indent=2)+'\n')
