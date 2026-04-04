# RPG public bundles mirror

Этот репозиторий публикует публичные JSON-бандлы на GitHub Pages.

Что раздаётся:
- `/bundles/reference.json`
- `/bundles/content.json`
- `/bundles/character-cards.json`
- `/bundles/manifest.json`

## Что нужно настроить

### Repository secrets
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

### Repository / environment variable
- `BUNDLE_PUBLIC_BASE_URL`
  - пример: `https://your-org.github.io/rpg-bundles`
  - или ваш custom domain

## Как публиковать
- вручную: **Actions → Publish public bundles → Run workflow**
- автоматически: workflow запускается каждые 15 минут

## Важно
В этот mirror должны попадать только публичные данные:
- справочники
- статьи
- approved/public карточки персонажей

Не публикуйте сюда приватные или live-admin данные.
