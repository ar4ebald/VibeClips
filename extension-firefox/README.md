# Vibe Clips для Firefox

Та же Vibe Clips, что и в папке `extension-chrome`: список трансляций по значку ✂, панель клипа под плеером YouTube
и скачивание MP4 в исходном качестве (до 1080p) за несколько секунд, без проигрывания.
Нужен Firefox 140 или новее.

## Установка

Обычный Firefox ставит насовсем только дополнения, подписанные Mozilla. Без подписи есть два способа.

**Временно (любой Firefox):**

1. Откройте `about:debugging#/runtime/this-firefox`.
2. Нажмите **Загрузить временное дополнение…** и выберите файл `manifest.json` из этой папки.
3. Обновите открытые вкладки YouTube (F5).

Дополнение работает до закрытия Firefox, потом его нужно загрузить снова.

**Насовсем (Firefox Developer Edition, Nightly или ESR):**

1. В `about:config` выставьте `xpinstall.signatures.required` в `false`.
2. Упакуйте содержимое этой папки в zip (`manifest.json` должен лежать в корне архива)
   и переименуйте архив в `vibe-clips.xpi`.
3. Перетащите `vibe-clips.xpi` в окно Firefox и подтвердите установку.

Можно и подписать дополнение в своём аккаунте на addons.mozilla.org как «не для каталога» —
тогда оно ставится в обычный Firefox.

Если кнопка ✂ в плеере не появилась, откройте `about:addons` → Vibe Clips → **Права**
и включите доступ к `www.youtube.com`.

## Отличия от версии для Chrome

Только манифест: в нём есть `browser_specific_settings` с id дополнения для Firefox.
Остальные файлы (`yt-capture.js`, `yt-panel.js`, `yt-panel.css`, `popup.*`, `icons`) такие же,
как в `extension-chrome`. Если правите их там, скопируйте и сюда.
