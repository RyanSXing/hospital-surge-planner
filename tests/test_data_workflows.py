"""Isolated integration checks for draft editing and the browser CSV mapping contract."""
import csv
import io
import json

import pytest
from fastapi.testclient import TestClient
from surge_api.main import create_app


@pytest.fixture
def data_client(tmp_path,monkeypatch):
    monkeypatch.setenv('APP_ENV','development')
    monkeypatch.setenv('DEMO_MODE','true')
    monkeypatch.setenv('ARTIFACT_LOCAL_DIR',str(tmp_path/'artifacts'))
    monkeypatch.delenv('REDIS_URL',raising=False)
    app=create_app('sqlite:///'+str(tmp_path/'workflow.db'),seed=True,start_dispatcher=False)
    with TestClient(app) as client:
        yield client


def checked(response,expected=200):
    assert response.status_code==expected,response.text
    return response.json()


def source(client):
    summary=checked(client.get('/api/workspaces/workspace-main/summary'))
    return checked(client.get('/api/datasets/'+summary['dataset']['id']))


def csv_file(rows,rename=None,extra=False):
    rename=rename or {}
    fields=list(dict.fromkeys(k for row in rows for k in row))
    output=io.StringIO();writer=csv.writer(output)
    writer.writerow([rename.get(k,k) for k in fields]+(['operator_note'] if extra else []))
    for row in rows:
        values=[json.dumps(row[k]) if isinstance(row.get(k),(dict,list,bool)) else row.get(k) for k in fields]
        writer.writerow(values+(['Explicitly ignored sample note'] if extra else []))
    return output.getvalue().encode()


def test_draft_typed_values_validate_and_commit_preserves_source(data_client):
    c=data_client;original=source(c)
    draft=checked(c.post('/api/dataset-drafts',json={'source_dataset_version_id':original['id'],'name':'Typed editor verification'}),201)
    facility={**original['facilities'][0],'name':'Edited synthetic hospital'}
    unit={**original['units'][0],'turnover_minutes':25}
    changed=checked(c.patch(f'/api/dataset-drafts/{draft["id"]}/entities',headers={'If-Match':str(draft['revision'])},json={'operations':[{'collection':'facilities','action':'upsert','entity':facility},{'collection':'units','action':'upsert','entity':unit}]}))
    report=checked(c.post(f'/api/dataset-drafts/{draft["id"]}/validate'))
    assert report['valid'],report
    assert 'facilities' in report['change_summary'] and 'units' in report['change_summary']
    committed=checked(c.post(f'/api/dataset-drafts/{draft["id"]}/commit',headers={'If-Match':str(changed['revision'])}),201)
    assert committed['id']!=original['id']
    assert next(f for f in committed['facilities'] if f['facility_id']==facility['facility_id'])['name']=='Edited synthetic hospital'
    assert next(u for u in committed['units'] if u['unit_id']==unit['unit_id'])['turnover_minutes']==25
    unchanged=checked(c.get('/api/datasets/'+original['id']))
    assert unchanged['facilities']==original['facilities'] and unchanged['units']==original['units']


def test_multifile_csv_mapping_preview_validate_and_atomic_commit(data_client):
    c=data_client;original=source(c)
    mapping={'sites.csv':{'collection':'facilities','columns':{'site_identifier':'facility_id'},'ignore':['operator_note']},'care-units.csv':{'collection':'units','columns':{'care_unit_identifier':'unit_id'},'ignore':[]}}
    stage=checked(c.post('/api/imports',json={'source_dataset_version_id':original['id'],'mapping':mapping}),201)
    facilities=[{**f,'name':'Mapped '+f['name']} for f in original['facilities']]
    checked(c.post(f'/api/imports/{stage["id"]}/files',files={'file':('sites.csv',csv_file(facilities,{'facility_id':'site_identifier'},extra=True),'text/csv')}))
    checked(c.post(f'/api/imports/{stage["id"]}/files',files={'file':('care-units.csv',csv_file(original['units'],{'unit_id':'care_unit_identifier'}),'text/csv')}))
    report=checked(c.post(f'/api/imports/{stage["id"]}/validate',json={'mapping':mapping}));assert report['valid'],report
    preview=checked(c.get(f'/api/imports/{stage["id"]}'))
    assert preview['row_counts']['facilities']==len(facilities)
    assert preview['preview_rows']['facilities'][0]['name'].startswith('Mapped ')
    committed=checked(c.post(f'/api/imports/{stage["id"]}/commit'),201)
    assert committed['facilities']==facilities
    assert committed['units']==original['units']
    assert committed['patients']==original['patients']
    assert checked(c.get('/api/datasets/'+original['id']))['facilities']==original['facilities']


def test_unknown_column_report_blocks_import_without_explicit_mapping(data_client):
    c=data_client;original=source(c)
    stage=checked(c.post('/api/imports',json={'source_dataset_version_id':original['id']}),201)
    checked(c.post(f'/api/imports/{stage["id"]}/files',files={'file':('facilities.csv',csv_file(original['facilities'],extra=True),'text/csv')}))
    report=checked(c.post(f'/api/imports/{stage["id"]}/validate'))
    assert not report['valid'] and any(e.get('field')=='operator_note' or 'operator_note' in e['message'] for e in report['errors'])
    assert c.post(f'/api/imports/{stage["id"]}/commit').status_code==422
