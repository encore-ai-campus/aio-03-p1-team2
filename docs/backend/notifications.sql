-- 원격 Supabase SQL Editor에서 전체 실행합니다.
-- 전제: cameras, motion_events, motion_analysis_questions가 설치되어 있어야 합니다.
-- 분석 완료와 알림 생성을 함께 저장합니다. Redis 발행은 커밋 후 서버에서 수행합니다.
BEGIN;

-- confirmed는 항상 알림 대상입니다. true이면 uncertain도 포함합니다.
-- 기존 사용자에게는 false가 적용되며, 저장된 질문은 유지됩니다.
ALTER TABLE public.motion_analysis_questions
    ADD COLUMN IF NOT EXISTS notify_on_uncertain BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN public.motion_analysis_questions.notify_on_uncertain
    IS 'false: 확인됨만 알림, true: 확인됨과 판단 어려움 모두 알림';

CREATE TABLE IF NOT EXISTS public.notifications (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    owner_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    event_id TEXT NOT NULL UNIQUE
        REFERENCES public.motion_events(id) ON DELETE CASCADE,
    camera_id UUID NOT NULL REFERENCES public.cameras(id),
    kind TEXT NOT NULL DEFAULT 'motion' CHECK (kind = 'motion'),
    verdict TEXT NOT NULL CHECK (verdict IN ('confirmed', 'uncertain')),
    message TEXT NOT NULL CHECK (char_length(btrim(message)) BETWEEN 1 AND 500),
    read BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.notifications IS '사건 최종 자동 분석에 따른 사용자별 알림';
COMMENT ON COLUMN public.notifications.event_id IS '사건당 알림 1개. 중복 생성은 UNIQUE로 방지';
COMMENT ON COLUMN public.notifications.owner_id IS '서버가 사건의 카메라 소유자로 결정하는 수신 사용자';
COMMENT ON COLUMN public.notifications.camera_id IS '서버가 사건의 실행에서 조회하는 카메라';
COMMENT ON COLUMN public.notifications.verdict IS '알림 사유. confirmed와 uncertain이 함께 있으면 confirmed';
COMMENT ON COLUMN public.notifications.read IS '읽음 여부. 본인 인증을 확인한 FastAPI에서만 변경';

-- 최신 알림 목록과 사용자별 id 이후 조회에 사용합니다.
CREATE INDEX IF NOT EXISTS notifications_owner_id_id
    ON public.notifications (owner_id, id DESC);

ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

-- 브라우저는 본인 알림 조회만 허용합니다.
-- 생성·읽음 변경·설정 변경은 소유권을 확인한 서버 전용 키로 수행합니다.
REVOKE ALL ON public.notifications FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.notifications TO authenticated;
GRANT ALL ON public.notifications TO service_role;
REVOKE ALL ON SEQUENCE public.notifications_id_seq FROM PUBLIC, anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.notifications_id_seq TO service_role;

DROP POLICY IF EXISTS notifications_select_own ON public.notifications;
CREATE POLICY notifications_select_own ON public.notifications
    FOR SELECT TO authenticated
    USING (owner_id = (SELECT auth.uid()));

-- 기존 질문과 마찬가지로 설정은 본인만 조회하고 서버에서만 변경합니다.
REVOKE ALL ON public.motion_analysis_questions FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.motion_analysis_questions TO authenticated;
GRANT ALL ON public.motion_analysis_questions TO service_role;
ALTER TABLE public.motion_analysis_questions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS motion_question_read ON public.motion_analysis_questions;
CREATE POLICY motion_question_read ON public.motion_analysis_questions
    FOR SELECT TO authenticated
    USING (user_id = (SELECT auth.uid()));

CREATE OR REPLACE FUNCTION public.notification_finish_analysis(
    p_analysis_id UUID, p_is_event BOOLEAN, p_result JSONB,
    p_error TEXT, p_latency_ms INTEGER
)
RETURNS JSONB LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE
    v_event_id TEXT;
    v_origin TEXT;
    v_camera UUID;
    v_owner UUID;
    v_name TEXT;
    v_uncertain BOOLEAN;
    v_verdict TEXT;
    v_notice public.notifications%ROWTYPE;
BEGIN
    IF p_is_event THEN
        UPDATE public.motion_event_analyses SET
            status=CASE WHEN p_result IS NULL THEN 'failed' ELSE 'succeeded' END,
            result=p_result, error_message=p_error, finished_at=now(), latency_ms=p_latency_ms
            WHERE id=p_analysis_id AND status='running' RETURNING event_id INTO v_event_id;
        IF NOT FOUND THEN RETURN NULL; END IF;
    ELSE
        UPDATE public.motion_analyses SET
            status=CASE WHEN p_result IS NULL THEN 'failed' ELSE 'succeeded' END,
            result=p_result, error_message=p_error, finished_at=now(), latency_ms=p_latency_ms
            WHERE id=p_analysis_id AND status='running' RETURNING origin INTO v_origin;
        IF NOT FOUND OR v_origin <> 'auto' THEN RETURN NULL; END IF;
        SELECT e.id INTO v_event_id FROM public.motion_analyses a
            JOIN public.motion_parts p ON p.id=a.part_id
            JOIN public.motion_events e ON e.id=p.event_id
            WHERE a.id=p_analysis_id AND e.capture_state='closed' AND e.final_part_index=1;
    END IF;
    IF p_result IS NULL OR v_event_id IS NULL THEN RETURN NULL; END IF;

    SELECT c.id,c.owner_id,c.name,COALESCE(q.notify_on_uncertain,false)
        INTO v_camera,v_owner,v_name,v_uncertain
        FROM public.motion_events e JOIN public.motion_runs r ON r.id=e.run_id
        JOIN public.cameras c ON c.id=r.camera_id
        LEFT JOIN public.motion_analysis_questions q ON q.user_id=c.owner_id
        WHERE e.id=v_event_id AND e.capture_state='closed';
    IF NOT FOUND THEN RETURN NULL; END IF;
    IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_result->'items') i WHERE i->>'verdict'='confirmed') THEN
        v_verdict := 'confirmed';
    ELSIF v_uncertain AND EXISTS(SELECT 1 FROM jsonb_array_elements(p_result->'items') i WHERE i->>'verdict'='uncertain') THEN
        v_verdict := 'uncertain';
    ELSE RETURN NULL;
    END IF;

    INSERT INTO public.notifications(owner_id,event_id,camera_id,verdict,message)
        VALUES(v_owner,v_event_id,v_camera,v_verdict,
            left(v_name,80)||CASE WHEN v_verdict='confirmed'
                THEN '에서 질문에 해당하는 행동이 확인됐어요.'
                ELSE '의 사건을 확인해 주세요. 분석 판단이 어려워요.' END)
        ON CONFLICT(event_id) DO NOTHING RETURNING * INTO v_notice;
    IF NOT FOUND THEN RETURN NULL; END IF;
    RETURN to_jsonb(v_notice);
END;
$$;
REVOKE ALL ON FUNCTION public.notification_finish_analysis(UUID,BOOLEAN,JSONB,TEXT,INTEGER)
    FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.notification_finish_analysis(UUID,BOOLEAN,JSONB,TEXT,INTEGER)
    TO service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
