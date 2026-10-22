"""관리자 권한 검사."""

from typing import Annotated
from fastapi import Depends, HTTPException
from backend.common.dependencies import Principal, User


def get_admin(user: User):
    if user.role != "admin":
        raise HTTPException(403, "관리자 권한이 필요합니다.")
    return user


Admin = Annotated[Principal, Depends(get_admin)]
