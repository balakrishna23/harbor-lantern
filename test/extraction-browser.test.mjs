import test from 'node:test';
import assert from 'node:assert/strict';
import { SalesnavExtractionBrowser, selectedRegionIds, geographyIncludePattern } from '../src/salesnav-extraction-browser.mjs';
const url=(selection='INCLUDED',title='Registered%20Nurse')=>'https://www.linkedin.com/sales/search/people?query='+encodeURIComponent(`(filters:List((type:CURRENT_TITLE,values:List((id:86,text:${title},selectionType:INCLUDED))),(type:REGION,values:List((id:100,text:Example,selectionType:${selection}))))))`);
test('search identity distinguishes included and excluded locations, and rejects changed title',()=>{
  assert.equal(selectedRegionIds(url()),'100:INCLUDED');assert.notEqual(selectedRegionIds(url()),selectedRegionIds(url('EXCLUDED')));
  const adapter=new SalesnavExtractionBrowser({});adapter.sales={url:()=>url('INCLUDED','Accountant')};
  assert.throws(()=>adapter.assertBatchSearch({searchUrl:url()}),/title filter is missing/);
  adapter.sales.url=()=>url('EXCLUDED');assert.throws(()=>adapter.assertBatchSearch({searchUrl:url()}),/geography differs/);
});
test('search count parsing does not mistake 150 or 200 results for zero',async()=>{
  const adapter=new SalesnavExtractionBrowser({});adapter.settled=async()=>{};
  for(const n of [150,200,1000]) {
    adapter.body=async()=>`${n.toLocaleString('en-US')} results\nPage 1 of ${n/25}`;
    assert.equal((await adapter.searchSize()).total,n);
  }
  adapter.body=async()=> 'No results found\n0 results';assert.equal((await adapter.searchSize()).pages,0);
  adapter.body=async()=> '4 results found';assert.equal((await adapter.searchSize()).pages,1);
});
test('100-page capped searches never invent an exact total from a rounded label',async()=>{
  const adapter=new SalesnavExtractionBrowser({});adapter.settled=async()=>{};adapter.body=async()=> '10K+ results\nPage 1 of 100';
  assert.deepEqual(await adapter.searchSize(),{pages:100,total:null,label:'10K+',capped:true});
});

test('a location already settled by selection avoids a duplicate wait; fresh checks still settle',async()=>{
  const adapter=new SalesnavExtractionBrowser({});let waits=0;
  adapter.settled=async()=>{waits++;};adapter.body=async()=> '150 results\nPage 1 of 6';
  assert.equal((await adapter.searchSize({alreadySettled:true})).pages,6);assert.equal(waits,0);
  await adapter.searchSize();assert.equal(waits,1);
});
test('geography selection survives changing counts and strictly matches state and country',()=>{
  const pattern=geographyIncludePattern({query:'Orange (NSW), New South Wales, Australia',kind:'locality'});
  assert.match('Include “Orange (NSW), New South Wales, Australia” in Region filter',pattern);
  assert.match('Include “Orange (NSW), New South Wales, Australia (1K+)” in Region filter',pattern);
  assert.doesNotMatch('Include “Orange (NSW), Victoria, Australia” in Region filter',pattern);
  assert.doesNotMatch('Include “Orange (NSW), New South Wales, Australia Extra” in Region filter',pattern);
});
test('empty page beyond collected results is an end boundary, but empty fresh searches are not',async()=>{
  const adapter=new SalesnavExtractionBrowser({});adapter.assertBatchSearch=()=>{};adapter.openExtractor=async()=>{};adapter.assertDestination=async()=>{};
  adapter.body=async()=> 'No leads matched your search\nExtracting: 0\nPage: 0\nSaved to your account: 0';
  adapter.sales={url:()=> 'https://www.linkedin.com/sales/search/people?page=77',getByRole:()=>({count:async()=>0})};
  assert.equal((await adapter.progress({maxExtracted:1858})).atLastPage,true);
  assert.equal((await adapter.progress({})).atLastPage,false);
});
