from typing import Annotated, Any

from pydantic import BaseModel, ConfigDict, StringConstraints

DataObject = dict[str, Any]
RunId = Annotated[str, StringConstraints(pattern=r"^[0-9a-f]{32}$")]
EventId = Annotated[str, StringConstraints(pattern=r"^[0-9a-f]{32}_e[0-9]{6}$")]


class RequestModel(BaseModel):
    # 오타 난 설정을 조용히 무시하지 않고 요청 오류로 알려줍니다.
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
