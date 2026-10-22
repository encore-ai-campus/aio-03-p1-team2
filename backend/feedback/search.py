"""피드백 목록의 검색 조건. 사용자·관리자 조회가 같은 검색 규칙을 사용합니다."""

import re


def apply_feedback_search(query, q="", feedback_id=None):
    # [UI-FB01] 기능·역할: 권한 조건 안에서 제목·내용 전체 검색. 수행 이유: 페이지를 자르기 전에 검색하고 입력을 정규식·필터 문법으로 해석하지 않습니다.
    text = q.strip()
    if text:
        literal = re.escape(text)
        value = '"' + literal.replace("\\", "\\\\").replace('"', '\\"') + '"'
        query = query.or_(f"title.imatch.{value},content.imatch.{value}")
    if feedback_id is not None:
        query = query.eq("id", feedback_id)
    return query
