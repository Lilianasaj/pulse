# HTTP API и WebSocket

JSON UTF-8, prefix `/api`, авторизация через cookie `pulse_session`. Клиент на том же origin; CORS для произвольных origin не включён. Ошибка: `{"error":"описание"}`. Коды: 400 валидация, 401 нет сессии, 403 Origin, 404 объект/маршрут отсутствует, 409 конфликт, 429 лимит, 500 сервер.

| Метод | Путь | Тело / параметры | Ответ |
|---|---|---|---|
| GET | `/health` | Без авторизации | `status`, `database`, `realtime` |
| POST | `/auth/register` | `username`, `display_name?`, `password` | `user`, cookie; 201 |
| POST | `/auth/login` | `username`, `password` | `user`, cookie |
| POST | `/auth/logout` | Пустой JSON | `ok`, отзыв текущей сессии |
| GET | `/me` | — | `user` |
| PATCH | `/me` | `display_name`, `bio` | `user` |
| GET | `/channels` | — | `channels[]`, включая последнее сообщение |
| POST | `/channels` | `name`, `description?` | `channel`; 201 |
| GET | `/channels/:id/messages` | `before?`, `after?`, `limit?` 1–100 | `messages[]`, `has_more` |
| POST | `/channels/:id/messages` | `text`, `client_id?` | `message`; 201 или 200 при повторе |
| GET | `/channels/:id/search` | `q` 1–100 символов | `messages[]`, `engine` |

История без курсора возвращает последние 50 записей в порядке возрастания ID. `before` — предыдущая страница без включения указанного ID; `after` — следующие сообщения по возрастанию ID, максимум `limit`. `has_more` означает полную страницу; следующая страница может оказаться пустой. Поиск возвращает до 50 результатов от новых к старым.

Сообщение:

```json
{"id":123,"channel_id":"general","user_id":"uuid","text":"Привет!","client_id":"uuid","created_at":"2026-10-29T12:00:00.000Z","username":"alex","display_name":"Алексей"}
```

Подключение WebSocket: `ws(s)://SERVER/ws`. Использует cookie из HTTP-входа. Не передавать сессию в query string.

События сервера:

```json
{"type":"ready","user_id":"uuid"}
{"type":"message","message":{"id":123,"channel_id":"general","text":"..."}}
{"type":"channel","channel":{"id":"uuid","name":"Новый канал"}}
```

В примерах событий объекты сокращены; в реальности сообщение включает перечисленные выше поля. Отправка идёт через HTTP POST; WS обслуживает серверные события, protocol ping/pong и переподключение. Код закрытия 4001 означает отзыв сессии; 1013 — медленный получатель. Максимум 10 одновременных соединений пользователя на процесс. Стандартные ответы лимитера могут содержать текст вместо JSON; клиент отображает общую ошибку.
