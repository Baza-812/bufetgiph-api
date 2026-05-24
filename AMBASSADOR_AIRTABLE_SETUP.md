# Настройка Airtable для программы "Старший по обедам"

## 📋 Этап 1: Добавление полей в существующие таблицы

### Таблица `Organizations`

Добавьте следующие поля:

1. **ContractType** (Single select)
   - Варианты: `Corporate`, `Ambassador`
   - По умолчанию: `Corporate`
   - Описание: Тип договора с организацией

2. **TeamMinForDelivery** (Number)
   - Формат: Integer (целое число)
   - По умолчанию: `9`
   - Описание: Минимальное количество ОПЛАЧЕННЫХ заказов для доставки

3. **TeamMinForFreeAmbassador** (Number)
   - Формат: Integer
   - По умолчанию: `10`
   - Описание: Минимальное количество ОПЛАЧЕННЫХ заказов для бесплатного обеда амбассадора

4. **PricingPlan** (Link to another record)
   - Связанная таблица: `PricingPlans` (создайте эту таблицу - см. ниже)
   - Разрешить связь с несколькими записями: НЕТ (только одна запись)
   - Описание: Тарифный план с ценами на обеды

5. **DeliveryAddress** (Long text)
   - Описание: Полный адрес доставки для команды амбассадора
   - Пример: "Москва, ул. Тверская, д. 10, офис 505"

---

### Таблица `Employees`

Обновите поле **Role** (Single select):

**Существующее поле `Role` - добавьте новые варианты:**
- Существующие: `Employee`, `Manager`, `Admin` (если есть)
- **ДОБАВИТЬ:**
  - `Ambassador` - организатор команды
  - `TeamMember` - член команды амбассадора

---

### Таблица `Order Lines`

Обновите поле **Line Type** (Single select):

**Существующее поле `Line Type` - добавьте новый вариант:**
- Существующие: `Included`, `Paid`, `Pending`
- **ДОБАВИТЬ:**
  - `Ambassador` - бесплатный обед для амбассадора

---

## 📋 Этап 2: Создание новых таблиц

### Таблица `PricingPlans`

Создайте новую таблицу со следующими полями:

1. **PlanName** (Single line text)
   - Primary field
   - Пример: "Амбассадор - Стандарт"

2. **FullMealPrice** (Currency)
   - Формат: Russian Ruble (₽)
   - Точность: 0 decimal places
   - Описание: Цена полного обеда (суп + салат + основное + гарнир)

3. **LightMealPrice** (Currency)
   - Формат: Russian Ruble (₽)
   - Точность: 0 decimal places
   - Описание: Цена лёгкого обеда (салат + основное + гарнир, без супа)

4. **Description** (Long text)
   - Описание: Описание тарифного плана
   - Пример: "Стандартный тариф для программы Амбассадоров. Полный обед включает все блюда."

5. **IsActive** (Checkbox)
   - По умолчанию: ✓ (checked)
   - Описание: Активен ли тариф

6. **Organizations** (Link to another record)
   - Связанная таблица: `Organizations`
   - Разрешить связь с несколькими записями: ДА
   - Описание: Организации, использующие этот тарифный план

**Пример записи:**
- PlanName: "Амбассадор - Стандарт"
- FullMealPrice: 350 ₽
- LightMealPrice: 280 ₽
- Description: "Стандартный тариф для команд амбассадоров"
- IsActive: ✓

---

### Таблица `AmbassadorApplications`

Создайте новую таблицу со следующими полями:

1. **FullName** (Single line text)
   - Primary field
   - Описание: ФИО заявителя

2. **Phone** (Phone number)
   - Описание: Контактный телефон

3. **Email** (Email)
   - Описание: Email для связи

4. **EstimatedTeamSize** (Number)
   - Формат: Integer
   - Описание: Предполагаемое количество человек в команде

5. **DeliveryAddress** (Long text)
   - Описание: Адрес доставки

6. **Status** (Single select)
   - Варианты:
     - `New` (новая заявка)
     - `Contacted` (связались с заявителем)
     - `Approved` (одобрена, организация создана)
     - `Rejected` (отклонена)
   - По умолчанию: `New`

7. **Notes** (Long text)
   - Описание: Внутренние заметки о заявке

8. **SubmittedAt** (Date)
   - Формат: Date and time
   - Описание: Дата и время подачи заявки

9. **ProcessedAt** (Date)
   - Формат: Date and time
   - Описание: Дата и время обработки заявки

10. **CreatedOrganization** (Link to another record)
    - Связанная таблица: `Organizations`
    - Разрешить связь с несколькими записями: НЕТ
    - Описание: Созданная организация (заполняется при одобрении)

---

## ✅ Проверка настройки

После создания всех полей и таблиц проверьте:

### 1. Таблица Organizations
- [ ] ContractType (Single select с вариантами Corporate/Ambassador)
- [ ] TeamMinForDelivery (Number)
- [ ] TeamMinForFreeAmbassador (Number)
- [ ] AmbassadorNotifyEmail (Email, опционально)
- [ ] AmbassadorTelegramChatId (Single line text, опционально)
- [ ] PricingPlan (Link to PricingPlans)
- [ ] DeliveryAddress (Long text)

### 2. Таблица Employees
- [ ] Role включает варианты: Ambassador, TeamMember

### 3. Таблица Order Lines
- [ ] Line Type включает вариант: Ambassador

### 4. Таблица PricingPlans (новая)
- [ ] Создана со всеми 6 полями
- [ ] Создана хотя бы одна тестовая запись

### 5. Таблица AmbassadorApplications (новая)
- [ ] Создана со всеми 10 полями

### 6. Таблица AmbassadorDeliveryRuns (cron минимума доставки)
- [ ] Создана с полями OrgCode, DeliveryDate, WarnEmailSent, CutoffProcessed, CutoffResult (см. ниже)

Нужна для **идемпотентности** предупреждения за час и обработки в момент Cutoff. Пока в Vercel **не** задано `TBL_AMBASSADOR_DELIVERY_RUNS`, cron пишет в ответ `logSkipped` и **не** шлёт письма и **не** отменяет заказы.

Рекомендуемые поля:

| Имя поля (по умолчанию) | Тип | Назначение |
|-------------------------|-----|------------|
| **OrgCode** | Single line text | Код организации (`OrgID`) |
| **DeliveryDate** | Single line text | Дата доставки `YYYY-MM-DD` |
| **WarnEmailSent** | Checkbox | Отправлено предупреждение «остался час» |
| **CutoffProcessed** | Checkbox | Сценарий после Cutoff уже отработан |
| **CutoffResult** | Single line text | Пусто / `ok` / `cancelled` |

Переименование полей: `FLD_ADR_*` в env (см. `lib/utils.js`).

### 7. Organizations — уведомления амбассадору (опционально)

| **AmbassadorNotifyEmail** | Email | Куда слать предупреждения; если пусто — Email сотрудника с ролью Ambassador |
| **AmbassadorTelegramChatId** | Single line text | `chat_id` Telegram (нужен `TELEGRAM_BOT_TOKEN` в Vercel) |

### Cron GET `/api/ambassador_cutoff_cron`

1. Настройте вызов **каждые 5–10 минут**:  
   `GET https://<ваш-api>/api/ambassador_cutoff_cron?key=<AMBASSADOR_CUTOFF_CRON_KEY>`
2. Env: `AMBASSADOR_CUTOFF_CRON_KEY`, `TBL_AMBASSADOR_DELIVERY_RUNS`, `RESEND_API_KEY`, `MAIL_FROM`, опционально `TELEGRAM_BOT_TOKEN`, `APP_ORIGIN`, отладка `AMBASSADOR_CUTOFF_DRY_RUN=1`.

---

## 🎯 Тестовые данные

### Создайте тестовый тарифный план:

**В таблице PricingPlans:**
```
PlanName: "Тестовый тариф Амбассадор"
FullMealPrice: 350
LightMealPrice: 280
Description: "Тестовый тариф для разработки"
IsActive: ✓
```

### Создайте тестовую организацию амбассадора:

**В таблице Organizations:**
```
OrgID: "amb_test_001"
Name: "Тестовая команда Амбассадора"
ContractType: Ambassador
TeamMinForDelivery: 9
TeamMinForFreeAmbassador: 10
PricingPlan: [ссылка на "Тестовый тариф Амбассадор"]
DeliveryAddress: "Москва, ул. Тестовая, д. 1"
Bank: [ссылка на ваш тестовый Bank]
Cutoff Time: "22:00" (должно уже быть)
```

### Создайте тестового амбассадора:

**В таблице Employees:**
```
FullName: "Иван Тестовый (Амбассадор)"
Organization: [ссылка на "Тестовая команда Амбассадора"]
Role: Ambassador
Status: Active
Order Token: test_amb_token_001
Email: test.ambassador@example.com
```

### Создайте несколько тестовых членов команды:

**В таблице Employees (создайте 3-5 записей):**
```
FullName: "Мария Тестовая (Команда)"
Organization: [ссылка на "Тестовая команда Амбассадора"]
Role: TeamMember
Status: Active
Order Token: test_team_token_001
Email: test.team1@example.com
```

---

## 📝 После завершения настройки

Когда всё готово, сообщите мне и мы перейдем к **Этапу 2: Backend API**.

Если возникнут вопросы по настройке Airtable - спрашивайте!
