import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { linkedinProfileUrl, nameTokens } from '../src/location-sheet-match.mjs';

const root=path.resolve(import.meta.dirname,'..');
const records=[];const runs=[];
const directory=path.join(root,'data/location-agent-results');
for(const id of fs.readdirSync(directory).filter(id=>/^[a-f0-9-]{36}$/.test(id))) {
  const file=path.join(directory,id,'report.json');if(!fs.existsSync(file))continue;
  const report=JSON.parse(fs.readFileSync(file,'utf8'));if(report.dataKind!=='real_search_export')continue;
  let job={};try{job=JSON.parse(fs.readFileSync(path.join(root,'data/location-agents',id+'.json'),'utf8'));}catch{}
  runs.push({id,name:job.name,inputRows:report.summary.inputRows,uniqueProfiles:report.profiles.length,duplicateInputRows:report.summary.duplicateRows||0});
  for(const p of report.profiles)records.push({runId:id,runName:job.name,profileId:p.id,name:p.fullName,url:p.url,
    finalUrl:linkedinProfileUrl(p.verification?.evidence?.finalUrl?.replace(/\/details\/education\/?(?:\?.*)?$/,'')),
    matched:['possible_register_match','multiple_register_matches'].includes(p.matchStatus),
    confirmedCandidateId:p.verification?.status==='confirmed'?p.verification.candidateId:null});
}
const groups=(rows,key)=>{
  const map=new Map();for(const r of rows){const k=key(r);if(!k)continue;if(!map.has(k))map.set(k,[]);map.get(k).push(r);}
  return [...map].filter(([,rows])=>rows.length>1).map(([key,rows])=>({key,count:rows.length,extraOccurrences:rows.length-1,records:rows}));
};
const canonical=url=>linkedinProfileUrl(url)?.replace(/\/$/,'')||null;
const compared=groups(records,r=>canonical(r.url));
const matchedRecords=records.filter(r=>r.matched);const matched=groups(matchedRecords,r=>canonical(r.url));
// Observed redirects connect opaque URLs and public slugs without guessing from names.
const parent=new Map();
const find=x=>{if(!parent.has(x))parent.set(x,x);if(parent.get(x)!==x)parent.set(x,find(parent.get(x)));return parent.get(x);};
for(const r of records){const a=canonical(r.url),b=canonical(r.finalUrl);if(a&&b)parent.set(find(a),find(b));}
const aliases=groups(records,r=>{const url=canonical(r.url);return url?find(url):null;});
const uniqueRecords=[...new Map(records.map(r=>[canonical(r.url)||r.profileId,r])).values()];
const sameNames=groups(uniqueRecords,r=>nameTokens(r.name).join(' '));
const db=new DatabaseSync(path.join(root,'data/hcrhub.sqlite'),{readOnly:true});
const assignments=db.prepare("SELECT id,full_name,ahpra_number,linkedin_url FROM candidates WHERE COALESCE(TRIM(linkedin_url),'')<>''").all();
const duplicateAssignments=groups(assignments,r=>canonical(r.linkedin_url));
const duplicateRegistrations=db.prepare("SELECT TRIM(ahpra_number) registrationNumber,COUNT(*) count,GROUP_CONCAT(id) candidateIds FROM candidates WHERE COALESCE(TRIM(ahpra_number),'')<>'' GROUP BY TRIM(ahpra_number) HAVING COUNT(*)>1").all();
const checks=db.prepare('SELECT run_id,profile_id,candidate_id,decision,profile_url,database_status FROM school_verification_checks').all();
const repeatedChecks=groups(checks,r=>`${r.run_id}|${r.profile_id}`);
const confirmed=checks.filter(r=>r.decision==='confirmed');
const candidateConfirmations=groups(confirmed,r=>r.candidate_id).filter(g=>new Set(g.records.map(r=>find(canonical(r.profile_url)||r.profile_url))).size>1);
db.close();
const report={createdAt:new Date().toISOString(),scope:'Saved real comparison reports and current candidate database; excludes active unexported extraction',
  counts:{runs:runs.length,comparedOccurrences:records.length,uniqueComparedUrls:new Set(records.map(r=>canonical(r.url)).filter(Boolean)).size,
    inputDuplicateRows:runs.reduce((n,r)=>n+r.duplicateInputRows,0),duplicateComparedUrlGroups:compared.length,
    extraComparedOccurrences:compared.reduce((n,g)=>n+g.extraOccurrences,0),matchedOccurrences:matchedRecords.length,
    uniqueMatchedUrls:new Set(matchedRecords.map(r=>canonical(r.url)).filter(Boolean)).size,duplicateMatchedUrlGroups:matched.length,
    extraMatchedOccurrences:matched.reduce((n,g)=>n+g.extraOccurrences,0),observedAliasDuplicateGroups:aliases.length,
    repeatedNameGroups:sameNames.length,candidateLinkedinAssignments:assignments.length,
    duplicateDatabaseLinkedinGroups:duplicateAssignments.length,duplicateDatabaseRegistrationGroups:duplicateRegistrations.length,
    repeatedSchoolCheckKeys:repeatedChecks.length,confirmedCandidatesWithDistinctObservedProfiles:candidateConfirmations.length},
  runs,duplicateComparedUrls:compared,duplicateMatchedUrls:matched,observedAliasDuplicates:aliases,
  sameNameDifferentProfiles:sameNames,duplicateDatabaseAssignments:duplicateAssignments,
  duplicateDatabaseRegistrations:duplicateRegistrations,repeatedSchoolChecks:repeatedChecks,
  confirmedCandidateProfileConflicts:candidateConfirmations};
const output=path.join(root,'outputs/duplicate-audit');fs.mkdirSync(output,{recursive:true});
fs.writeFileSync(path.join(output,'duplicate-audit.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify({counts:report.counts,duplicateDatabaseRegistrations:duplicateRegistrations.slice(0,5),duplicateDatabaseAssignments:duplicateAssignments.slice(0,3)},null,2));
