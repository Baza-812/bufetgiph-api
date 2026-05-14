# Ужин через клона сотрудника (Airtable + API)

Цель: второй заказ на ту же дату без смены модели «один заказ — один сотрудник» в `Orders`: у основного сотрудника остаётся обед, у **клона** (отдельная запись в `Employees`) — ужин на ту же дату.

## Поля в Airtable (таблица Employees)

| Поле | Тип | У кого | Назначение |
|------|-----|--------|------------|
| **Dinner** | Checkbox | Основной сотрудник | Включён самозаказ ужина и UI «Ужин». |
| **Dinner Type** | Single select: `Standard`, `Light` | Основной | Как у типа порции обеда: Standard — салат+суп в наборах, Light — только суп в «лёгком» варианте квиза. |
| **Dinner Primary** | Link to Employees (одна ссылка) | **Клон (ужин)** | Ссылка на запись **основного** сотрудника. Имя клона вручную, напр. «Иванов Иван (ужин)». |
| **Email** у клона | Email | Клон | Рабочий адрес команды (как договорились); регистрация клона не используется. |

Имена полей по умолчанию совпадают с колонками выше. Переопределение через env в `lib/utils.js`:

- `FLD_EMP_DINNER` (по умолчанию `Dinner`)
- `FLD_EMP_DINNER_TYPE` (по умолчанию `Dinner Type`)
- `FLD_EMP_DINNER_PRIMARY_LINK` (по умолчанию `Dinner Primary`)

## API

- **`GET /api/employee_info`** — доп. поля: `dinner`, `dinnerType`, `dinnerEmployeeId` (id клона, если `Dinner` и найден ровно один клон по ссылке).
- **`POST /api/order`** — тело: `dinnerEmployeeId` (опционально). Токен и `employeeID` — **основного**; заказ создаётся на **клона**. Несовместимо с `forEmployeeID` (HR «за другого»).
- **`GET /api/busy`** — при `dinnerEmployeeID` + `org` + `token` возвращает ещё `dinnerBusy`, `dinnerAwaitingPayment` (после проверки токена и связи клон→основной).
- **`GET /api/hr_orders?mode=single&...&dinnerEmployeeID=recClone`** — в ответе `dinnerSummary` (как `summary`, но для клона).
- **`POST /api/order_cancel`**, **`POST /api/order_update`** — основной может отменять/менять заказ, если владелец заказа — его клон-ужин (проверка по **Dinner Primary**).

## Фронт

Персональная ссылка только на основного. Квиз ужина: `/order/quiz?...&meal=dinner&dinnerType=Standard|Light`. В `POST /api/order` уходит `dinnerEmployeeId`.

## Этапы внедрения

1. Создать поля в Airtable, вручную завести клонов.  
2. Задеплоить API с этим коммитом.  
3. Проверить: обед → ужин с подтверждения; модалка дня; отмена/изменение ужина.

## Устранение неполадок

- У клона в поле **Status** должно быть **Active** (или пусто — как у основного в логике `verify`). Иначе `employee_info` не вернёт `dinnerEmployeeId`, блок ужина в UI не появится.
- Если `dinner: true`, но `dinnerEmployeeId` пустой: проверьте, что у **одного** клона в **Dinner Primary** выбран именно этот основной сотрудник (record id совпадает с тем, кто в ссылке заказа).
