// Isolated PostgreSQL/WASM: never accesses the remote Supabase project.
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
    CREATE TABLE profiles(id uuid PRIMARY KEY REFERENCES auth.users(id),status text);
    CREATE TABLE motion_events(id text PRIMARY KEY,detected_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE notifications(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,owner_id uuid REFERENCES auth.users(id),
      event_id text UNIQUE REFERENCES motion_events(id),verdict text,message text,created_at timestamptz NOT NULL DEFAULT now());
  `)
  const sql = await readFile(new URL('../../../docs/backend/discord.sql', import.meta.url), 'utf8')
  await db.exec(sql)
  await db.exec(sql)
  const owner = randomUUID(), other = randomUUID(), discord = '1561992883345817622'
  await db.query('INSERT INTO auth.users VALUES($1),($2)', [owner, other])
  await db.query("INSERT INTO profiles VALUES($1,'active'),($2,'active')", [owner, other])
  const rpc = async (query, args = []) => (await db.query(query, args)).rows[0].value
  const sync = (id = discord) => rpc('SELECT discord_sync_connection($1,$2,$3) AS value', [owner,id,'NoteCam 사용자'])
  const preference = (enabled) => rpc('SELECT discord_set_notifications($1,$2) AS value', [owner,enabled])
  const claim = () => rpc('SELECT discord_claim_delivery() AS value')
  const finish = (job, status, retry = null, token = job.claim_token) => rpc('SELECT discord_finish_delivery($1,$2,$3,$4,$5,$6) AS value',
    [job.notification_id,token,status,status === 'sent' ? '1561992883345817630' : null,status === 'failed' ? '일시적 오류' : null,retry])
  async function notice(createdAt = new Date().toISOString()) {
    const event = randomUUID().replaceAll('-','')+'_e000001'
    await db.query('INSERT INTO motion_events(id) VALUES($1)', [event])
    return (await db.query("INSERT INTO notifications(owner_id,event_id,verdict,message,created_at) VALUES($1,$2,'confirmed','사건 확인',$3) RETURNING id", [owner,event,createdAt])).rows[0].id
  }
  await sync()
  assert.equal(await preference(true), null, 'test DM must be verified before opt-in')
  await notice()
  assert.equal(await claim(), null, 'linking must not automatically enable DM')
  await db.query('UPDATE discord_connections SET dm_channel_id=$1,dm_verified_at=now() WHERE user_id=$2', [discord,owner])
  assert.equal((await preference(true)).notifications_enabled,true)
  assert.equal((await sync()).notifications_enabled,true,'same identity sync must preserve preferences')
  await notice('2000-01-01T00:00:00Z')
  assert.equal(await claim(),null,'no historical notifications when enabling')
  const id = await notice()
  let job = await claim()
  assert.equal(Number(job.notification_id),Number(id)); assert.equal(job.owner_id,owner); assert.equal(job.discord_user_id,discord)
  assert.equal(await claim(),null,'a leased job cannot be claimed again')
  assert.equal(await finish(job,'sent',null,randomUUID()),false,'wrong claim cannot acknowledge')
  assert.equal(await finish(job,'failed',30),true)
  assert.equal(await claim(),null,'retry must respect its deadline')
  await db.query("UPDATE discord_deliveries SET available_at=now()-interval '1 second' WHERE notification_id=$1",[id])
  job = await claim(); assert.equal(job.attempts,2)
  const previous = job
  await db.query("UPDATE discord_deliveries SET lease_until=now()-interval '1 second' WHERE notification_id=$1",[id])
  job = await claim(); assert.equal(job.attempts,3); assert.notEqual(job.claim_token,previous.claim_token)
  assert.equal(await finish(previous,'sent'),false,'expired worker cannot acknowledge a reclaimed job')
  assert.equal(await finish(job,'sent'),true)
  assert.equal(await finish(job,'sent'),false,'repeated completion is ignored')
  assert.equal(await claim(),null)
  await notice(); await preference(false)
  assert.equal(await claim(),null,'turning off cancels queued deliveries')
  await preference(true); await notice()
  job = await claim()
  await db.query("UPDATE discord_deliveries SET lease_until=now()-interval '1 second',attempts=5 WHERE notification_id=$1",[job.notification_id])
  assert.equal(await claim(),null,'attempt limit must also cover worker crashes')
  assert.equal((await db.query('SELECT status FROM discord_deliveries WHERE notification_id=$1',[job.notification_id])).rows[0].status,'failed')
  const changed = await sync('1561992883345817623')
  assert.equal(changed.notifications_enabled,false); assert.equal(changed.dm_channel_id,null)
  await assert.rejects(db.query('SELECT discord_sync_connection($1,$2,$3)',[other,changed.discord_user_id,'다른 계정']),/duplicate key/)
  await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)",[other])
  await db.exec('SET ROLE authenticated')
  assert.equal((await db.query('SELECT * FROM discord_connections')).rows.length,0)
  await assert.rejects(db.exec('SELECT * FROM discord_deliveries'),/permission denied/)
  await assert.rejects(db.query('SELECT discord_set_notifications($1,true)',[owner]),/permission denied/)
  await assert.rejects(db.exec('UPDATE discord_connections SET notifications_enabled=true'),/permission denied/)
  await db.exec('RESET ROLE')
  await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)",[owner])
  await db.exec('SET ROLE authenticated')
  assert.equal((await db.query('SELECT * FROM discord_connections')).rows.length,1)
  await db.exec('RESET ROLE; SET ROLE anon')
  await assert.rejects(db.exec('SELECT * FROM discord_connections'),/permission denied/)
  console.log('PASS Discord SQL: reapply, explicit opt-in, no backfill, snapshot, claim fencing, retries, recovery, identity change, RLS')
} finally { await db.close() }
