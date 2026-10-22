# 팀 작업 규칙

## 1. 폴더 담당
| 폴더 | 담당 | 내용 |
|---|---|---|
| backend/ | 민철 | FastAPI 서버 |
| frontend/ | 희래, 진혁 | React 화면 |
| vision/ | 원철 | OpenCV / Gemini |
| docs/ | 전원 | 문서 |

- 자기 담당 폴더 안에서만 작업합니다.
- 다른 폴더를 수정해야 하면 담당자에게 먼저 말합니다.

## 2. 브랜치 규칙
- `main`에는 직접 푸시할 수 없습니다. (보호 규칙 적용)
- 작업할 때마다 `main`에서 새 브랜치를 만듭니다.
- 브랜치 이름: `종류/기능명`
  - `feature/login-api`
  - `fix/camera-error`
  - `docs/readme-update`

## 3. 작업 순서
1. `git switch main` → `git pull` (항상 최신 상태에서 시작)
2. `git switch -c feature/기능명`
3. 작업 후 커밋, `git push origin feature/기능명`
4. GitHub에서 Pull Request 생성
5. 머지 (가능하면 팀원 1명에게 확인받기)
6. 머지 후 브랜치 삭제, 로컬에서 `git switch main` → `git pull`

## 4. 커밋 메시지
`종류: 내용` 형식으로 씁니다.
- `feat: 로그인 API 추가`
- `fix: 이미지 저장 경로 오류 수정`
- `docs: README 실행 방법 추가`
- `refactor: 중복 코드 정리`

## 5. Pull Request 규칙
- 제목에 무엇을 했는지 한 줄로 씁니다.
- 본문에 변경 내용과 테스트 방법을 간단히 적습니다.
- 머지 전에 팀원에게 한번 봐달라고 요청합니다. (강제는 아니지만 권장)
- 리뷰 코멘트가 달리면 확인하고 답을 남깁니다.
- PR은 작게, 자주 올립니다. (하루 이상 묵히지 않기)

## 6. 절대 하지 말 것
- `.env`, API 키, 비밀번호를 커밋하지 않습니다. (`.env.example`만 올림)
- `node_modules`, `.venv`, `__pycache__`를 커밋하지 않습니다.
- `git push --force`를 쓰지 않습니다.
- 충돌이 났을 때 혼자 덮어쓰지 말고 팀에 물어봅니다.

## 7. 소통
- 다른 사람 코드에 영향을 주는 변경(API 주소, DB 구조 등)은 미리 공지합니다.