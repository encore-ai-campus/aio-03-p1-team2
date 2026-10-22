from typing import Annotated
from fastapi import APIRouter, Depends, File, Form, Query, UploadFile
from backend.common.dependencies import User
from backend.vision.dependencies import get_motion_run_service
from backend.vision.errors import ApplicationError
from backend.vision.models.common import RunId
from backend.vision.models.runs import (
    CameraCreate,
    CameraRead,
    FrameRead,
    RunCreate,
    RunRead,
    RunStopRead,
)
from backend.vision.services.browser_motion import MAX_FRAME_BYTES
from backend.vision.services.motion_run_service import MotionRunService

router = APIRouter(prefix="/api/motion", tags=["모션 실행"])


@router.get("/cameras", response_model=list[CameraRead])
async def list_cameras(
    user: User,
    service: Annotated[MotionRunService, Depends(get_motion_run_service)],
):
    return await service.list_cameras(user.id)


@router.post("/cameras", response_model=CameraRead, status_code=201)
async def create_camera(
    payload: CameraCreate,
    user: User,
    service: Annotated[MotionRunService, Depends(get_motion_run_service)],
):
    return await service.create_camera(payload, user.id)


@router.post("/runs", response_model=RunRead, status_code=202)
async def create_run(
    payload: RunCreate,
    user: User,
    service: Annotated[MotionRunService, Depends(get_motion_run_service)],
):
    return await service.create(payload, user.id)


@router.get("/runs", response_model=list[RunRead])
async def list_runs(
    user: User,
    service: Annotated[MotionRunService, Depends(get_motion_run_service)],
    limit: int = Query(20, ge=1, le=100),
    active_only: bool = Query(False),
):
    return await service.list(user.id, limit, active_only=active_only)


@router.get("/runs/{run_id}", response_model=RunRead)
async def get_run(
    run_id: RunId,
    user: User,
    service: Annotated[MotionRunService, Depends(get_motion_run_service)],
):
    return await service.get(run_id, user.id)


@router.post("/runs/{run_id}/stop", response_model=RunStopRead, status_code=202)
async def stop_run(
    run_id: RunId,
    user: User,
    service: Annotated[MotionRunService, Depends(get_motion_run_service)],
):
    return await service.stop(run_id, user.id)


@router.post("/runs/{run_id}/frames", response_model=FrameRead, status_code=202)
async def upload_frame(
    run_id: RunId,
    user: User,
    service: Annotated[MotionRunService, Depends(get_motion_run_service)],
    file: Annotated[UploadFile, File(description="원본 해상도 JPEG, 최대 5 MiB")],
    sequence_no: Annotated[
        int, Form(ge=0, description="실행 내에서 증가하는 프레임 번호")
    ],
    timestamp_sec: Annotated[
        float, Form(ge=0, allow_inf_nan=False, description="촬영 시작 후 경과 초")
    ],
):
    try:
        data = await file.read(MAX_FRAME_BYTES + 1)
        if len(data) > MAX_FRAME_BYTES:
            raise ApplicationError(
                "FRAME_TOO_LARGE", "JPEG는 5 MiB 이하여야 합니다.", 413
            )
        return await service.submit_frame(
            run_id, user.id, data, sequence_no, timestamp_sec
        )
    finally:
        await file.close()
