# Таблица Airtable: обратная связь по обедам (`MealFeedback`)

Создайте таблицу с именем **`MealFeedback`** (или задайте другое имя в `TBL_MEAL_FEEDBACK` в env API).

## Поля

| # | Имя поля (рекомендуется) | Тип | Обязательно | Описание |
|---|--------------------------|-----|---------------|----------|
| 1 | **Employee** | Link → `Employees` | да | Сотрудник |
| 2 | **Organization** | Link → `Organizations` | да | Организация (record id), для отчётов |
| 3 | **MealDate** | Single line text | да | Дата обеда в формате `YYYY-MM-DD` (как в заказах) |
| 4 | **Rating** | Single select | да | Варианты **строго** (как в API): `Очень плохо`, `Плохо`, `Нормально`, `Хорошо`, `Отлично` |
| 5 | **Comment** | Long text | нет | Комментарий, до 300 символов |
| 6 | **Order** | Link → `Orders` | рекомендуется | Один заказ на эту дату и этого сотрудника; API заполняет при `POST /api/feedback` |

Дополнительно (по желанию):

- **Created time** (Created time) — автоматически фиксирует момент создания записи; в API не передаётся.

## Состав заказа в таблице MealFeedback (через связь Order)

1. Создайте в **MealFeedback** поле **Order** (или другое имя) — тип **Link to another record** → таблица **Orders**, одна запись (не allow multiple).
2. В env API проекта задайте **`FLD_FB_ORDER=Order`** (или имя вашего поля). Пока переменная **не** задана, API ссылку на заказ не записывает (старые базы без поля не ломаются).
3. Дальше в **MealFeedback** добавьте поля **Lookup** (или **Rollup**) с **Lookup source** = поле **Order**:
   - если в **Orders** уже есть формулы/текст с составом (**Main**, **Side**, **Extra** и т.п. — как у вас в базе) — сделайте **Lookup** каждого такого поля в MealFeedback;
   - для строк **Order Lines**: в таблице **Orders** часто есть поле-ссылка на несколько Order Lines — тогда удобнее в **Orders** завести одно **Rollup** или **Formula**, собирающее названия позиций в одну строку, и в MealFeedback один **Lookup** на это поле.

Итог: **MealFeedback** не считает состав сам — он **подтягивает** уже посчитанные в **Orders** (и при необходимости Order Lines) значения через связь **Order**.

## Single select `Rating`

Создайте опции **в точности** с такими подписями (регистр и пробелы как в таблице):

1. Очень плохо  
2. Плохо  
3. Нормально  
4. Хорошо  
5. Отлично  

В интерфейсе заказа пользователь выбирает эмодзи; в Airtable сохраняется соответствующая русская подпись.

## Соответствие эмодзи → Rating

| Эмодзи | Rating |
|--------|--------|
| 😞 | Очень плохо |
| 😐 | Плохо |
| 🙂 | Нормально |
| 😃 | Хорошо |
| 🤩 | Отлично |

## Env (опционально)

Если имена таблицы/полей отличаются:

```env
TBL_MEAL_FEEDBACK=MealFeedback
FLD_FB_EMPLOYEE=Employee
FLD_FB_ORG=Organization
FLD_FB_MEAL_DATE=MealDate
FLD_FB_RATING=Rating
FLD_FB_COMMENT=Comment
# после добавления поля Order в Airtable:
FLD_FB_ORDER=Order
```

## API

- `GET /api/feedback?employeeID=&org=&token=` — список дат для оценки и флаги «уже отправлено»
- `POST /api/feedback` — тело JSON: `{ employeeID, org, token, date, rating, comment? }`

Один отзыв на пару сотрудник + дата (повторная отправка вернёт `409`).
