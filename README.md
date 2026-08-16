# 바카라산악회 실시간 슬롯 경매 - Render Web Service 버전

이 버전은 실제 다중 접속을 지원합니다.

- 실제 접속 닉네임만 표시
- 접속 중: 초록색 원형 불
- 접속 종료: 빨간색 원형 불 (5분간 표시 후 목록 제거)
- 방장 머니 지급 실시간 동기화
- 입찰/최고가/로그 실시간 동기화
- 방장 비밀번호 기본값: 9981
- 새 경매 재설정 시 참가자 보유금은 유지

## Render
기존 Static Site가 아니라 새 **Web Service**로 배포해야 합니다.
Build Command: npm install
Start Command: npm start
Environment Variable: ADMIN_PASSWORD=9981
