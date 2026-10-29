# Pulse Chat

Кроссплатформенный чат для учебного проекта: **React + Express + WebSocket + PostgreSQL**, Electron для десктопа и Capacitor для Android/iOS. Один сервер, одна база и общий интерфейс для всех устройств.

## Что работает

- Регистрация, вход, выход, сессии на 7 дней, редактирование имени и описания профиля.
- Общие каналы: список, создание, описание, последнее сообщение, индикатор новых сообщений.
- Доставка сообщений через WebSocket, автоматическое переподключение, история после перезапуска.
- Курсорная подгрузка истории, поиск внутри канала, многострочные сообщения до 4000 символов.
- Защита от дубликатов по `client_id`; повтор сетевого запроса с тем же ID безопасен.
- Адаптивный интерфейс: на телефоне список каналов и переписка открываются отдельными экранами.
- Desktop-клиент Electron; проекты Android Studio и Xcode; web manifest для установки сайта браузером, где это поддерживается.
- Docker Compose, проверка здоровья, долговременное хранение, CI, нагрузочный скрипт.
- Опциональный Elasticsearch с транзакционной очередью индексации и SQL-поиском при недоступности ES.

Все каналы доступны всем зарегистрированным участникам. Это чат каналов, без личных переписок, файлов, звонков, закрытых групп и модерации. Профиль уже реализован; векторный поиск — следующий этап, см. [ROADMAP.md](docs/ROADMAP.md).

## Быстрый старт без Docker

Требуется **Node.js 24 LTS** и npm. PostgreSQL для этого режима не нужен: сервер сам создаст `data/pulse.db`.

```bash
npm ci
npm run build
npm start
```

Открыть **http://localhost:3000**, зарегистрировать аккаунт. Для проверки общения открыть второй браузер или приватное окно и зарегистрировать второго пользователя. Данные сохраняются между перезапусками. Если Electron не загрузился во время установки, для запуска только сервера допустимо `ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci`.

Разработка с обновлением кода:

```bash
npm run dev
```

Открыть **http://localhost:5173**. Если нужен доступ по IP, задайте `PUBLIC_ORIGIN=http://IP:5173` в `.env`. Порт API по умолчанию 3000; Vite проксирует `/api` и `/ws`. В production веб-страница и API обслуживаются одним процессом на порту 3000.

## Развёртывание на виртуальной машине

Нужны Linux, Docker Engine с Compose v2, доступный TCP-порт 3000 и минимум 2 ГБ RAM (для Elasticsearch желательно 4 ГБ и больше). База и Redis наружу не публикуются.

1. Скопировать/клонировать проект на VM и перейти в его каталог.
2. Запустить, подставив доступный одногруппникам IP:

```bash
chmod +x scripts/deploy.sh
./scripts/deploy.sh http://192.168.1.50:3000
```

Скрипт создаёт `.env` с новым случайным паролем БД, если файла нет, и запускает `docker compose up -d --build`. Уже существующий `.env` сохраняется. Если он был создан для локальной разработки, сначала вручную задайте непустой `POSTGRES_PASSWORD` и правильный `PUBLIC_ORIGIN`.

3. Открыть **http://192.168.1.50:3000** с другого устройства. Это пример адреса — использовать реальный IP вашей VM. На хостинге открыть порт в firewall/security group; если VM за NAT, настроить проброс порта. У всех клиентов должен быть одинаковый адрес сервера.

```bash
docker compose ps
docker compose logs -f app
curl http://192.168.1.50:3000/api/health
```

Не менять `POSTGRES_PASSWORD` после инициализации volume без изменения пароля внутри PostgreSQL. `docker compose down` сохраняет данные; `docker compose down -v` удаляет их.

### HTTPS

Для общедоступного использования поставить перед сервером Caddy/Nginx и включить TLS. Пример Caddy — [docs/Caddyfile](docs/Caddyfile). В `.env` установить `PUBLIC_ORIGIN=https://chat.example.com`, `COOKIE_SECURE=true`, `TRUST_PROXY=true`, `BIND_IP=127.0.0.1`. В этом режиме посетители используют домен на 443; прямой порт приложения доступен только с VM. Затем `docker compose up -d`.

HTTP по IP предназначен для демонстрации в учебной сети. Сессии используют cookie `HttpOnly`, `SameSite=Lax`; флаг `Secure` включается при HTTPS. Пароли хранятся как scrypt с индивидуальной солью; session token в БД хранится только в виде SHA-256.

### Elasticsearch

По умолчанию работает поиск по SQL без дополнительных сервисов. Чтобы включить Elasticsearch, установить в `.env`:

```dotenv
ELASTICSEARCH_URL=http://elasticsearch:9200
```

```bash
# При необходимости настроить vm.max_map_count на Docker-хосте согласно требованиям ES.
docker compose --profile search up -d --build
```

Очередь `search_outbox` заполняется в одной транзакции с сообщением триггером базы данных. Индексатор обрабатывает до 100 записей каждые две секунды и повторяет неуспешные операции. Накопленные до включения ES сообщения тоже индексируются. Поиск ES имеет задержку; при сбое или пустой выдаче сервер ищет подстроку в SQL. ES ищет фразу с анализатором, SQL — буквальную подстроку; результаты этих режимов могут отличаться. ES не опубликован наружу, отключённая аутентификация допустима только внутри закрытой Compose-сети.

## Десктоп: Electron

Запустить сервер. В другом терминале:

```bash
# Linux/macOS
CHAT_URL=http://localhost:3000 npm run desktop
# PowerShell
$env:CHAT_URL='http://localhost:3000'; npm run desktop
```

Для раздаваемого установщика изменить `desktop/config.json` на реальный адрес VM, затем выполнить на нужной ОС:

```bash
npm run desktop:pack
```

Результат в `release/`: AppImage на Linux, NSIS на Windows, DMG на macOS. Собирать Windows/macOS установщики удобнее на соответствующих ОС; подпись и notarization не настроены. Electron загружает серверный интерфейс, сохраняет cookie своим профилем, не предоставляет странице Node.js или IPC и ограничивает навигацию адресом сервера. Сервер должен быть доступен для работы приложения.

## Мобильное приложение: Android / iOS

Это native WebView-клиенты Capacitor с общим React-интерфейсом. Их серверный URL загружается непосредственно в WebView, поэтому API, cookie и WebSocket используют один origin. Нет автономного режима или push-уведомлений. Используется Capacitor вместо отдельной реализации на Flutter, чтобы один разработчик сопровождал один UI.

`android/` и `ios/` уже созданы. Для Android установите Android Studio, Android SDK 36 и JDK 21 или новее, совместимый с Gradle проекта. Минимальная версия устройства — Android 7 (API 24). Для iOS нужен macOS с Xcode и настройкой signing team.

```bash
npm ci
node scripts/mobile-config.js http://192.168.1.50:3000
npm run mobile:sync
npm run mobile:open
```

В Android Studio дождаться Gradle Sync, выбрать устройство и Run. APK: **Build → Generate App Bundles or APKs → Generate APKs** либо:

```bash
cd android
./gradlew assembleDebug
# Windows: gradlew.bat assembleDebug
```

APK: `android/app/build/outputs/apk/debug/app-debug.apk`. Для эмулятора Android адрес хоста обычно **http://10.0.2.2:3000**. При использовании этого адреса задать серверу `PUBLIC_ORIGIN=http://10.0.2.2:3000`. На реальном телефоне использовать IP VM/компьютера в доступной сети, а не `localhost`. Изменение адреса требует повторного `npm run mobile:sync` и пересборки.

Для iOS:

```bash
node scripts/mobile-config.js https://chat.example.com
npm run mobile:sync
npx cap open ios
```

В Xcode выбрать команду подписи и устройство. Для iOS используйте HTTPS; исключения ATS для произвольных HTTP-серверов в проект не добавлены. Публикация в App Store/Google Play и сертификаты не входят в проект. Установка сайта через браузер — ещё один способ пользоваться чатом на телефоне без SDK; offline cache отсутствует.

## Тестирование и нагрузка

```bash
npm test
npm run build
npm run load:local -- --users=5 --messages=100 --rps=40
```

Последняя команда запускает изолированный сервер с временной базой в памяти, создаёт пользователей и завершает сервер после теста. Для VM:

```bash
npm run load -- --url=http://192.168.1.50:3000 --users=10 --messages=100 --rps=10
```

`messages` — сообщений **на каждого пользователя**, `rps` — запросов в секунду **на каждого пользователя**. Скрипт создаёт отдельные тестовые аккаунты, отправляет текст в «Общий», открывает по WebSocket на пользователя, выводит ошибки, p50/p95/p99 и число полученных событий. Его данные остаются на целевом сервере. Перед интенсивным тестом увеличить `MESSAGE_RATE_LIMIT` в `.env`, например до `3000`, и перезапустить приложение. Общий IP-лимит API — 3000 запросов/минуту/процесс; auth — 30/минуту/IP. Лимит сообщений по умолчанию — 120/минуту/пользователь/процесс. Ошибка 429 учитывается в отчёте как отказ, а не успех.

Проверка PostgreSQL:

```bash
TEST_DATABASE_URL=postgres://pulse:password@localhost:5432/pulse_test npm test
```

Использовать отдельную тестовую БД: тесты создают таблицы и записи, не очищая чужие данные. GitHub Actions проверяет SQLite и PostgreSQL раздельно. См. [отчёт проверки](docs/VERIFICATION.md) и [JSON нагрузки](docs/load-result.json).

## GitHub и ветки

В комплекте `repository.bundle` с полной Git-историей и ветками. Если проект скачан как ZIP без `.git`, восстановить репозиторий **в соседний каталог**:

```bash
git clone repository.bundle ../pulse-chat-repo
cd ../pulse-chat-repo
git branch -a
git remote rename origin archive
git remote add origin https://github.com/YOUR_LOGIN/pulse-chat.git
git push -u origin main
for branch in develop feature/server feature/web feature/clients feature/infra; do
  git push origin "refs/remotes/archive/$branch:refs/heads/$branch"
done
```

В PowerShell вместо shell-цикла выполнить `git push origin refs/remotes/archive/develop:refs/heads/develop` и аналогичную команду для каждой feature-ветки. GitHub-репозиторий предварительно создать в своём аккаунте. В этой среде проект не публиковался в пользовательском GitHub, доступ к нему не предоставлен.

## Демонстрация преподавателю

1. Показать README, коммиты и ветки в GitHub.
2. Показать `docker compose ps`, `/api/health` и сайт по IP VM.
3. Войти двумя аккаунтами на разных устройствах; создать канал и обменяться сообщениями.
4. Показать поиск, профиль, подгрузку истории и сохранение после `docker compose restart app`.
5. Запустить desktop-клиент и Android-клиент с тем же адресом.
6. Запустить нагрузку, показать JSON с `accepted`, `errors`, задержками и доставками.

## Структура

| Каталог | Назначение |
|---|---|
| `server/` | API, авторизация, БД, WebSocket, Redis, индексатор |
| `web/` | React, стили, адаптивный UI, manifest |
| `desktop/` | Electron и конфигурация упаковки |
| `android/`, `ios/` | Нативные проекты Capacitor |
| `scripts/` | Разработка, запуск VM, конфиг мобильного клиента, нагрузка |
| `tests/` | Интеграционные тесты API и WebSocket |
| `docs/` | План, архитектура, API, проверки, следующие этапы |

## Эксплуатация

Резервная копия: `docker compose exec -T postgres pg_dump -U pulse pulse > backup.sql`. Восстановление в пустую БД: `docker compose exec -T postgres psql -U pulse pulse < backup.sql`. Для SQLite остановить процесс и скопировать `data/pulse.db` вместе с существующими `-wal`/`-shm` файлами, либо воспользоваться SQLite backup API. Копия должна храниться вне VM.

Redis переносит события между несколькими экземплярами приложения. История всегда восстанавливается из БД. События Pub/Sub не являются долговременной очередью; при их потере клиент восстанавливает последнюю страницу истории после переподключения. Лимиты HTTP в этой версии хранятся в памяти каждого экземпляра. Для нескольких реплик требуется распределённый rate limiter. SQLite предназначен для одного процесса, PostgreSQL — для VM и дальнейшего расширения.
