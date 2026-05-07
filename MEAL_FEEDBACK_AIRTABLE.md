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

Дополнительно (по желанию):

- **Created time** (Created time) — автоматически фиксирует момент создания записи; в API не передаётся.

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
```

## API

- `GET /api/feedback?employeeID=&org=&token=` — список дат для оценки и флаги «уже отправлено»
- `POST /api/feedback` — тело JSON: `{ employeeID, org, token, date, rating, comment? }`

Один отзыв на пару сотрудник + дата (повторная отправка вернёт `409`).
