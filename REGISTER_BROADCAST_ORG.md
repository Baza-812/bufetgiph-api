# Массовая рассылка письма регистрации по организации

`POST /api/register_broadcast_org` — то же письмо и персональная ссылка, что после `/api/register`, для всех **активных** сотрудников с email в указанной организации.

## Переменные окружения

- Те же, что для обычной регистрации: `RESEND_API_KEY`, `MAIL_FROM`, `APP_ORIGIN` и т.д. (см. `lib/register_mail.js`).
- `REGISTER_BROADCAST_KEY` — опционально; общий секрет для вызова без HR-сессии.
- `REGISTER_BROADCAST_DELAY_MS` — пауза между письмами (по умолчанию `400`), чтобы не упираться в лимиты Resend.

## Авторизация (одно из двух)

1. **Секрет:** заголовок `x-register-broadcast-key` или поле JSON `broadcastKey` = значение `REGISTER_BROADCAST_KEY`.
2. **HR:** как в других HR-эндпоинтах: `employeeID` + `token` вызывающего HR, роль содержит `HR`, организация и токен совпадают с переданным `org`.

## Тело запроса (JSON)

- `org` (обязательно) — код организации (`Org ID` из Airtable).
- `targetEmployeeId` — опционально `RECORD_ID()` сотрудника в Airtable; если указан, обрабатывается только эта строка (должен принадлежать той же `org`).
- `dryRun` — если `true`, письма **не** отправляются и в Airtable **не** пишутся токены; сотрудники без токена заказа помечаются как `skipped` с причиной `no_order_token_dry_run`.

## Примеры

Dry-run (HR):

```bash
curl -sS -X POST "https://<host>/api/register_broadcast_org" \
  -H "Content-Type: application/json" \
  -d '{"org":"MY_ORG","employeeID":"recXXX","token":"<emp-order-token>","dryRun":true}'
```

Рассылка по секрету:

```bash
curl -sS -X POST "https://<host>/api/register_broadcast_org" \
  -H "Content-Type: application/json" \
  -H "x-register-broadcast-key: <REGISTER_BROADCAST_KEY>" \
  -d '{"org":"MY_ORG"}'
```

Ответ: `total`, `sent`, `skipped`, массив `results` по каждой записи сотрудника.
