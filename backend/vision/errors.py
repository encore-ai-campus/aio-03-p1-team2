"""main.py의 공통 오류 응답에 전달할 비전 오류."""


class ApplicationError(Exception):
    def __init__(self, code: str, message: str, status_code: int = 400):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code


class NotFound(ApplicationError):
    def __init__(self, name: str):
        super().__init__("NOT_FOUND", f"{name}을 찾을 수 없습니다.", 404)


class Conflict(ApplicationError):
    def __init__(self, message: str):
        super().__init__("CONFLICT", message, 409)
