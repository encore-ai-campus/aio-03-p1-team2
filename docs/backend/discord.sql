-- Discord 전용 추가 스키마. 기존 알림/분석 함수는 변경하지 않습니다.
-- 전제: auth.users, profiles, notifications, motion_events가 설치되어 있어야 합니다.
-- 이 파일 작성/테스트 단계에서는 원격 DB에 적용하지 않습니다.
BEGIN;

CREATE TABLE IF NOT EXISTS public.discord_connections (
    user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    discord_user_id TEXT NOT NULL UNIQUE CHECK (discord_user_id ~ '^[1-9][0-9]{16,19}$'),
    display_name TEXT NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 100),
    dm_channel_id TEXT CHECK (dm_channel_id ~ '^[1-9][0-9]{16,19}$'),
    dm_verified_at TIMESTAMPTZ,
    notifications_enabled BOOLEAN NOT NULL DEFAULT false,
    enabled_at TIMESTAMPTZ,
    last_error TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (NOT notifications_enabled OR
        (dm_channel_id IS NOT NULL AND dm_verified_at IS NOT NULL AND enabled_at IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS public.discord_deliveries (
    notification_id BIGINT PRIMARY KEY REFERENCES public.notifications(id) ON DELETE CASCADE,
    discord_user_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sending','sent','failed','skipped')),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
    available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    lease_until TIMESTAMPTZ,
    claim_token UUID,
    message_id TEXT,
    sent_at TIMESTAMPTZ,
    last_error TEXT
);
CREATE INDEX IF NOT EXISTS discord_deliveries_pending
    ON public.discord_deliveries (status,available_at,lease_until) WHERE status IN ('queued','sending');

ALTER TABLE public.discord_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.discord_deliveries ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.discord_connections, public.discord_deliveries FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.discord_connections TO authenticated;
GRANT ALL ON public.discord_connections, public.discord_deliveries TO service_role;
DROP POLICY IF EXISTS discord_connection_read ON public.discord_connections;
CREATE POLICY discord_connection_read ON public.discord_connections FOR SELECT TO authenticated
    USING (user_id=(SELECT auth.uid()));

CREATE OR REPLACE FUNCTION public.discord_sync_connection(p_user UUID,p_discord_id TEXT,p_name TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE v_row public.discord_connections%ROWTYPE;
BEGIN
    INSERT INTO public.discord_connections AS c(user_id,discord_user_id,display_name)
    VALUES(p_user,p_discord_id,p_name)
    ON CONFLICT(user_id) DO UPDATE SET
        discord_user_id=EXCLUDED.discord_user_id,display_name=EXCLUDED.display_name,updated_at=now(),
        dm_channel_id=CASE WHEN c.discord_user_id=EXCLUDED.discord_user_id THEN c.dm_channel_id END,
        dm_verified_at=CASE WHEN c.discord_user_id=EXCLUDED.discord_user_id THEN c.dm_verified_at END,
        notifications_enabled=c.notifications_enabled AND c.discord_user_id=EXCLUDED.discord_user_id,
        enabled_at=CASE WHEN c.discord_user_id=EXCLUDED.discord_user_id THEN c.enabled_at END,
        last_error=CASE WHEN c.discord_user_id=EXCLUDED.discord_user_id THEN c.last_error END
    RETURNING * INTO v_row;
    RETURN to_jsonb(v_row);
END;
$$;

CREATE OR REPLACE FUNCTION public.discord_set_notifications(p_user UUID,p_enabled BOOLEAN)
RETURNS JSONB LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE v_row public.discord_connections%ROWTYPE;
BEGIN
    UPDATE public.discord_connections SET
        notifications_enabled=p_enabled,
        enabled_at=CASE WHEN p_enabled AND NOT notifications_enabled THEN now() ELSE enabled_at END,
        last_error=NULL,updated_at=now()
    WHERE user_id=p_user AND (NOT p_enabled OR (dm_verified_at IS NOT NULL AND dm_channel_id IS NOT NULL))
    RETURNING * INTO v_row;
    IF NOT FOUND THEN RETURN NULL; END IF;
    IF NOT p_enabled THEN
        UPDATE public.discord_deliveries d SET status='skipped'
        FROM public.notifications n WHERE n.id=d.notification_id AND n.owner_id=p_user AND d.status='queued';
    END IF;
    RETURN to_jsonb(v_row);
END;
$$;

CREATE OR REPLACE FUNCTION public.discord_enqueue_notification()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
BEGIN
    -- opt-in 이후의 새 알림만 등록합니다. SQL 재적용 시 과거 알림을 채우지 않습니다.
    INSERT INTO public.discord_deliveries(notification_id,discord_user_id)
    SELECT NEW.id,c.discord_user_id FROM public.discord_connections c
    JOIN public.profiles p ON p.id=c.user_id AND p.status='active'
    WHERE c.user_id=NEW.owner_id AND c.notifications_enabled
      AND NEW.created_at>=c.enabled_at
    ON CONFLICT(notification_id) DO NOTHING;
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS discord_notification_created ON public.notifications;
CREATE TRIGGER discord_notification_created AFTER INSERT ON public.notifications
    FOR EACH ROW EXECUTE FUNCTION public.discord_enqueue_notification();

CREATE OR REPLACE FUNCTION public.discord_claim_delivery()
RETURNS JSONB LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE v_id BIGINT; v_row public.discord_deliveries%ROWTYPE; v_notice JSONB;
BEGIN
    UPDATE public.discord_deliveries SET status='failed',last_error='마지막 발송의 처리 기한이 만료됐습니다.',claim_token=NULL
    WHERE status='sending' AND lease_until<=now() AND attempts>=5;
    SELECT notification_id INTO v_id FROM public.discord_deliveries
    WHERE attempts<5 AND ((status='queued' AND available_at<=now()) OR (status='sending' AND lease_until<=now()))
    ORDER BY notification_id FOR UPDATE SKIP LOCKED LIMIT 1;
    IF NOT FOUND THEN RETURN NULL; END IF;
    UPDATE public.discord_deliveries SET status='sending',attempts=attempts+1,
        lease_until=now()+INTERVAL '2 minutes',claim_token=gen_random_uuid()
    WHERE notification_id=v_id RETURNING * INTO v_row;
    SELECT jsonb_build_object('owner_id',n.owner_id,'event_id',n.event_id,'message',n.message,
        'verdict',n.verdict,'created_at',n.created_at,'detected_at',e.detected_at)
    INTO v_notice FROM public.notifications n JOIN public.motion_events e ON e.id=n.event_id WHERE n.id=v_id;
    RETURN to_jsonb(v_row)||v_notice;
END;
$$;

CREATE OR REPLACE FUNCTION public.discord_finish_delivery(
    p_id BIGINT,p_claim UUID,p_status TEXT,p_message_id TEXT,p_error TEXT,p_retry_after INTEGER
)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
BEGIN
    IF p_status NOT IN ('sent','failed','skipped') OR (p_status='sent' AND p_message_id IS NULL) THEN
        RAISE EXCEPTION '잘못된 Discord 발송 결과입니다.';
    END IF;
    UPDATE public.discord_deliveries SET
        status=CASE WHEN p_status='failed' AND p_retry_after IS NOT NULL AND attempts<5 THEN 'queued' ELSE p_status END,
        available_at=now()+make_interval(secs=>greatest(1,least(COALESCE(p_retry_after,0),3600))),
        message_id=p_message_id,sent_at=CASE WHEN p_status='sent' THEN now() END,
        last_error=left(p_error,500),claim_token=NULL,lease_until=NULL
    WHERE notification_id=p_id AND status='sending' AND claim_token=p_claim;
    RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION public.discord_sync_connection(UUID,TEXT,TEXT),
    public.discord_set_notifications(UUID,BOOLEAN),public.discord_enqueue_notification(),
    public.discord_claim_delivery(),public.discord_finish_delivery(BIGINT,UUID,TEXT,TEXT,TEXT,INTEGER)
    FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.discord_sync_connection(UUID,TEXT,TEXT),
    public.discord_set_notifications(UUID,BOOLEAN),public.discord_enqueue_notification(),
    public.discord_claim_delivery(),public.discord_finish_delivery(BIGINT,UUID,TEXT,TEXT,TEXT,INTEGER)
    TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
