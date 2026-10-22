// Isolated PostgreSQL/WASM check; never connects to Supabase.
// npm install --prefix /tmp/notecam-notification-sql-test --no-save @electric-sql/pglite
// PGLITE_MODULE=/tmp/notecam-notification-sql-test/node_modules/@electric-sql/pglite/dist/index.js node tests/check_notifications_sql.mjs
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
const { PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite')
const db = new PGlite()
try {
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE SCHEMA auth;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
      'SELECT nullif(current_setting(''request.jwt.claim.sub'',true),'''')::uuid';
    GRANT USAGE ON SCHEMA auth TO authenticated;
    CREATE TABLE auth.users(id uuid PRIMARY KEY);
    CREATE TABLE cameras(id uuid PRIMARY KEY,owner_id uuid REFERENCES auth.users(id),name text NOT NULL);
    CREATE TABLE motion_runs(id text PRIMARY KEY,camera_id uuid REFERENCES cameras(id));
    CREATE TABLE motion_events(id text PRIMARY KEY,run_id text REFERENCES motion_runs(id),capture_state text,final_part_index int);
    CREATE TABLE motion_parts(id uuid PRIMARY KEY,event_id text REFERENCES motion_events(id));
    CREATE TABLE motion_analyses(id uuid PRIMARY KEY,part_id uuid REFERENCES motion_parts(id),origin text,status text,result jsonb,error_message text,finished_at timestamptz,latency_ms int CHECK(latency_ms>=0));
    CREATE TABLE motion_event_analyses(id uuid PRIMARY KEY,event_id text REFERENCES motion_events(id),status text,result jsonb,error_message text,finished_at timestamptz,latency_ms int CHECK(latency_ms>=0));
    CREATE TABLE motion_analysis_questions(user_id uuid PRIMARY KEY REFERENCES auth.users(id),questions jsonb);
  `)
  const sql = await readFile(new URL('../docs/backend/notifications.sql', import.meta.url), 'utf8')
  await db.exec(sql)
  await db.exec(sql) // Repeat application preserves rows and permissions.
  const owner = randomUUID(), other = randomUUID(), camera = randomUUID()
  await db.query('INSERT INTO auth.users VALUES ($1),($2)', [owner, other])
  await db.query("INSERT INTO cameras VALUES ($1,$2,'거실 카메라')", [camera, owner])
  await db.query("INSERT INTO motion_analysis_questions(user_id,questions) VALUES ($1,'[]')", [owner])
  async function scenario({ verdicts=['confirmed'], uncertain=false, parts=1, event=false, origin='auto', state='closed', failed=false } = {}) {
    const run = randomUUID(), eid = run.replaceAll('-','')+'_e000001', pid=randomUUID(), aid=randomUUID()
    await db.query('UPDATE motion_analysis_questions SET notify_on_uncertain=$1 WHERE user_id=$2', [uncertain, owner])
    await db.query('INSERT INTO motion_runs VALUES ($1,$2)', [run,camera])
    await db.query('INSERT INTO motion_events VALUES ($1,$2,$3,$4)', [eid,run,state,parts])
    await db.query('INSERT INTO motion_parts VALUES ($1,$2)', [pid,eid])
    if (event) await db.query("INSERT INTO motion_event_analyses(id,event_id,status) VALUES ($1,$2,'running')",[aid,eid])
    else await db.query("INSERT INTO motion_analyses(id,part_id,origin,status) VALUES ($1,$2,$3,'running')",[aid,pid,origin])
    const result = failed ? null : {items:verdicts.map(verdict=>({question_id:randomUUID(),verdict,summary:'관찰 결과'}))}
    const args=[aid,event,result,failed?'Gemini 실패':null,10]
    const finish=()=>db.query('SELECT notification_finish_analysis($1,$2,$3,$4,$5) AS notice',args)
    const notice=(await finish()).rows[0].notice
    assert.equal((await finish()).rows[0].notice,null,'duplicate completion must not create or re-emit a notification')
    const record=(await db.query('SELECT status FROM '+(event?'motion_event_analyses':'motion_analyses')+' WHERE id=$1',[aid])).rows[0]
    assert.equal(record.status,failed?'failed':'succeeded')
    if(notice) { assert.equal(notice.owner_id,owner); assert.equal(notice.camera_id,camera); assert.equal(notice.read,false) }
    return notice
  }
  assert.equal((await scenario()).verdict,'confirmed')
  assert.equal((await scenario({verdicts:['uncertain'],uncertain:true})).verdict,'uncertain')
  assert.equal(await scenario({verdicts:['uncertain']}),null)
  assert.equal(await scenario({verdicts:['not_confirmed'],uncertain:true}),null)
  assert.equal((await scenario({verdicts:['uncertain','confirmed'],uncertain:true})).verdict,'confirmed')
  assert.equal(await scenario({parts:2}),null,'intermediate part must not notify')
  assert.equal((await scenario({parts:2,event:true})).verdict,'confirmed')
  assert.equal(await scenario({origin:'manual'}),null)
  assert.equal(await scenario({state:'collecting'}),null)
  assert.equal(await scenario({failed:true}),null)
  await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)",[other])
  await db.exec('SET ROLE authenticated')
  assert.equal((await db.query('SELECT * FROM notifications')).rows.length,0,'other user must not read notifications')
  await assert.rejects(db.query('SELECT notification_finish_analysis($1,false,null,null,0)',[randomUUID()]),/permission denied/)
  await assert.rejects(db.exec('UPDATE notifications SET read=true'),/permission denied/)
  await db.exec('RESET ROLE')
  await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)",[owner])
  await db.exec('SET ROLE authenticated')
  assert.equal((await db.query('SELECT * FROM notifications')).rows.length,4)
  await db.exec('RESET ROLE')
  await db.exec('SET ROLE anon')
  await assert.rejects(db.exec('SELECT * FROM notifications'),/permission denied/)
  console.log('PASS actual PostgreSQL: verdict settings, final results, manual/failure exclusion, duplicate completion, RLS and server-only writes/RPC')
} finally { await db.close() }
