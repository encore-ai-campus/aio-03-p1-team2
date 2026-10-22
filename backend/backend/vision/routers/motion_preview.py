import asyncio
import time
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import Response, StreamingResponse
from fastapi.security import HTTPAuthorizationCredentials

from backend.common.dependencies import Principal, User, bearer, get_user
from backend.vision.services.preview_security import decode_token, issue_token
from backend.vision.dependencies import get_motion_preview_service
from backend.vision.errors import ApplicationError
from backend.vision.models.common import RunId
from backend.vision.services.motion_preview_service import MotionPreviewService

router = APIRouter(prefix="/api/motion/runs", tags=["모션 미리보기"])


async def preview_user(
    run_id: RunId,
    request: Request,
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer)],
    ticket: str | None = Query(None, max_length=2048),
) -> Principal:
    if ticket is None:
        return await get_user(request, credentials)
    payload = decode_token(request, ticket, scope="motion_preview")
    if payload.get("run_id") != run_id:
        raise HTTPException(404, "모션 실행을 찾을 수 없습니다.")
    return Principal(payload["sub"], "user", payload["exp"])


PreviewUser = Annotated[Principal, Depends(preview_user)]


@router.post("/{run_id}/preview-ticket")
async def preview_ticket(
    run_id: RunId,
    request: Request,
    user: User,
    service: Annotated[MotionPreviewService, Depends(get_motion_preview_service)],
):
    # 브라우저의 img 태그에 로그인 헤더를 붙이기 어려워 짧은 전용 URL을 제공합니다.
    await service.get(run_id, user.id)
    seconds = min(
        request.app.state.vision_settings.ticket_seconds,
        max(0, int(user.expires_at - time.time())),
    )
    if seconds == 0:
        raise HTTPException(401, "로그인 토큰을 갱신하세요.")
    ticket = issue_token(
        request, user.id, scope="motion_preview", seconds=seconds, run_id=run_id
    )
    return {
        "url": f"/api/motion/runs/{run_id}/preview.mjpg?ticket={ticket}",
        "image_url": f"/api/motion/runs/{run_id}/preview.jpg?ticket={ticket}",
        "expires_in": seconds,
    }


@router.get("/{run_id}/preview.jpg")
async def preview_jpeg(
    run_id: RunId,
    user: PreviewUser,
    service: Annotated[MotionPreviewService, Depends(get_motion_preview_service)],
):
    preview = await service.get(run_id, user.id)
    frame = await asyncio.to_thread(preview.snapshot, timeout=1)
    if frame is None:
        raise ApplicationError(
            "PREVIEW_WARMING_UP", "첫 영상 프레임을 준비 중입니다.", 503
        )
    return Response(
        frame.jpeg,
        media_type="image/jpeg",
        headers={
            "Cache-Control": "private, no-store",
            "Referrer-Policy": "no-referrer",
            "X-Frame-Index": str(frame.frame_index),
            "X-Elapsed-Sec": str(frame.elapsed_sec),
        },
    )


async def frames(preview, request: Request, expires_at: float):
    last_index = -1
    with preview.subscribe():
        while (
            not preview.closed
            and time.time() < expires_at
            and not await request.is_disconnected()
        ):
            frame = await asyncio.to_thread(
                preview.snapshot, after=last_index, timeout=0.5
            )
            if frame is None:
                continue
            last_index = frame.frame_index
            yield (
                b"--frame\r\nContent-Type: image/jpeg\r\nContent-Length: "
                + str(len(frame.jpeg)).encode()
                + b"\r\n\r\n"
                + frame.jpeg
                + b"\r\n"
            )


@router.get("/{run_id}/preview.mjpg")
async def preview_mjpeg(
    run_id: RunId,
    request: Request,
    user: PreviewUser,
    service: Annotated[MotionPreviewService, Depends(get_motion_preview_service)],
):
    preview = await service.get(run_id, user.id)
    return StreamingResponse(
        frames(preview, request, user.expires_at),
        media_type="multipart/x-mixed-replace; boundary=frame",
        headers={
            "Cache-Control": "private, no-store",
            "Referrer-Policy": "no-referrer",
            "X-Accel-Buffering": "no",
        },
    )
