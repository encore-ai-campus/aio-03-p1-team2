# NoteCam 제출용 GitHub 업로드 매뉴얼

## 0. 이번 ZIP 구성

```text
notecam_final_package/
├── README.md
├── docs/
│   ├── architecture.md
│   ├── api-design.md
│   ├── database-design.md
│   ├── screen-design.md
│   └── submission-guide.md
└── screenshots/
    └── 01-landing.jpg ~ 18-admin-feedback-process.jpg (18장)
```

**이번 자료는 제출용 저장소에 올릴 문서와 화면 이미지입니다. 실제 개발용 Backend/Frontend 저장소의 소스코드는 수정하지 않습니다.**

## 1. 업로드 전 개인정보 확인 (중요)

1. ZIP을 풀고 `screenshots/`의 18개 이미지를 확인합니다.
2. 계정 이메일, 사용자 ID, 실존 인물 얼굴, 사적인 실내 모습 등이 공개되면 안 되는지 확인합니다.
3. 민감한 내용은 이미지 편집으로 가리거나 해당 이미지를 제외하세요.
4. 이미지를 제외했다면 `README.md`와 `docs/screen-design.md`의 해당 이미지 링크도 삭제해야 합니다.

## 2. 가장 쉬운 GitHub 웹 업로드 방법

1. https://github.com/encore-ai-campus/aio-03-p1-team2 접속.
2. 기존 `README.md`를 열고 연필(Edit) 버튼을 눌러 **이번 ZIP의 README.md 전체 내용**으로 교체합니다.
3. 우측 상단 `Commit changes...` 클릭 → 메시지 `docs: update NoteCam README` → Commit.
4. 저장소 첫 화면에서 `Add file` → `Upload files` 클릭.
5. ZIP을 푼 폴더에서 **`docs` 폴더와 `screenshots` 폴더를 함께 드래그**해 업로드합니다. 폴더 경로가 유지되는지 업로드 목록에서 확인합니다.
6. `Commit changes...` 클릭 → 메시지 `docs: add architecture API DB screen design and screenshots` → Commit.
7. README의 이미지와 문서 링크를 모두 클릭해 정상 표시되는지 확인합니다.

> GitHub 브라우저/운영체제에 따라 폴더 드래그가 잘 안 되면 아래 Git 명령 방식이 더 확실합니다.

## 3. Git 명령으로 업로드 (Windows PowerShell)

```powershell
git clone https://github.com/encore-ai-campus/aio-03-p1-team2.git
cd aio-03-p1-team2
```

ZIP 압축을 풀어 `README.md`, `docs`, `screenshots`를 **방금 clone한 폴더의 최상위**에 복사합니다. 기존 `backend/`, `frontend/` 폴더는 건드리지 않습니다.

```powershell
git status
git add README.md docs screenshots
git commit -m "docs: finalize NoteCam project documentation"
git push origin main
```

> 다른 팀원이 동시에 main을 수정했다면 먼저 `git pull --rebase origin main`으로 최신 내용을 반영한 뒤 충돌을 확인하세요. 무조건 `git push --force` 하지 마세요.

## 4. 업로드 후 검수

- [ ] README 상단 이미지 6개가 보인다.
- [ ] `docs/database-design.md`의 Mermaid 논리·물리 ERD가 렌더링된다.
- [ ] `docs/architecture.md`의 구성도·시퀀스가 보인다.
- [ ] `docs/api-design.md`의 API 목록을 열 수 있다.
- [ ] `docs/screen-design.md`의 18장 이미지 링크가 정상이다.
- [ ] `.env`, 실제 API 키, JWT, 비밀번호가 올라가지 않았다.
- [ ] 제출용 README가 개발용 저장소의 최신 코드 기준과 일치한다.

## 5. 운영 로그 대시보드에 대한 정확한 표기

제공된 캡처 중 `관리자 운영현황`은 사용자·피드백 등 운영 통계 화면입니다. `카메라 기록`과 `Gemini 분석`은 저장된 사건/분석 이력을 보여줍니다. **실시간 시스템 로그의 수집·조회·시각화 화면을 구현했다는 증빙으로 자동 대체하지 않습니다.**

과제에서 실시간 운영 로그 대시보드를 필수로 요구한다면, 현재 구현으로 충족하는지 별도 확인하고 필요 시 구현·시연해야 합니다. 이 ZIP은 그 기능을 새로 개발한 파일이 아닙니다.
