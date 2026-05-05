const DICTIONARY = {
  en: {
    "title": "Kinescrape · Save Kinescope videos",
    "hero.kicker": "The fastest way to grab Kinescope videos",
    "hero.h1.a": "Pull any video",
    "hero.h1.b": "out of Kinescope",
    "hero.lede": "Paste a link — get a clean MP4. No extra uploads, no signup",
    "trust.privacy": "no server storage",
    "trust.batch": "don't save your videos",
    "trust.free": "multi-link support",
    "stage.combineProgress": "Combining {p}%",
    "stage.loadingCombiner": "Loading combiner",
    "input.placeholder": "Paste link, embed code, or page HTML",
    "input.tip": "Paste any Kinescope link, embed code, or full page HTML — multiple links are detected automatically",
    "btn.paste": "Paste",
    "btn.find": "Find",
    "btn.get": "Get video",
    "btn.getMany": "Get {n} videos",
    "btn.save": "Save MP4",
    "btn.saveZip": "Save ZIP",
    "preview.kicker": "Detected",
    "result.kicker": "Ready",
    "found.title": "Found videos",
    "found.count.zero": "—",
    "found.count.one": "1 video",
    "found.count.many": "{n} videos",
    "found.included": "included",
    "found.skipped": "skipped",
    "found.untitled": "Untitled video",
    "quality.title": "Quality",
    "quality.meta": "audio + video combined",
    "quality.available": "available: {list}",
    "quality.best": "Best",
    "stage.preparing": "Getting ready",
    "stage.find": "Finding video",
    "stage.download": "Downloading",
    "stage.downloadVideos": "Downloading videos",
    "stage.combine": "Combining",
    "stage.save": "Saving",
    "stage.done": "Saved",
    "stage.serverMux": "Download",
    "stage.error": "Something went wrong",
    "step.find": "Find",
    "step.download": "Download",
    "step.combine": "Combine",
    "step.save": "Save",
    "stat.speed": "Speed",
    "stat.eta": "ETA",
    "stat.progress": "Progress",
    "advanced.title": "Advanced",
    "advanced.filename": "File name",
    "advanced.referer": "Referer",
    "advanced.log": "Process log",
    "foot.privacy": "No upload, no tracking",
    "speed.label": "{rate}/s",
    "speed.idle": "—",
    "eta.idle": "—",
    "eta.seconds": "{s}s",
    "eta.minutes": "{m}m {s}s",
    "eta.hours": "{h}h {m}m",
    "queue.of": "{i} / {n}",
    "lang.toggle": "RU",
    "err.empty": "Paste a Kinescope link, page URL, or HTML.",
    "err.clipboard": "Clipboard empty or permission denied. Long-press → Paste.",
    "err.nothing": "Nothing selected to download.",
  },
  ru: {
    "title": "Kinescrape · Скачать видео с Kinescope",
    "hero.kicker": "Самый быстрый способ скачать видео с Kinescope",
    "hero.h1.a": "Вытащи любое видео",
    "hero.h1.b": "с Kinescope",
    "hero.lede": "Вставь ссылку — получи готовый MP4. Без лишних загрузок и регистрации",
    "trust.privacy": "без хранения на сервере",
    "trust.batch": "не сохраняем твои видео",
    "trust.free": "поддержка нескольких ссылок",
    "stage.combineProgress": "Сборка {p}%",
    "stage.loadingCombiner": "Загрузка комбайнера",
    "input.placeholder": "Вставь ссылку, embed или HTML страницы",
    "input.tip": "Вставь любую ссылку Kinescope, embed-код или весь HTML страницы — несколько видео находятся автоматически",
    "btn.paste": "Вставить",
    "btn.find": "Найти",
    "btn.get": "Скачать",
    "btn.getMany": "Скачать {n} видео",
    "btn.save": "Сохранить MP4",
    "btn.saveZip": "Сохранить ZIP",
    "preview.kicker": "Найдено",
    "result.kicker": "Готово",
    "found.title": "Найденные видео",
    "found.count.zero": "—",
    "found.count.one": "1 видео",
    "found.count.many": "{n} видео",
    "found.included": "включено",
    "found.skipped": "пропущено",
    "found.untitled": "Без названия",
    "quality.title": "Качество",
    "quality.meta": "аудио + видео объединены",
    "quality.available": "доступно: {list}",
    "quality.best": "Лучшее",
    "stage.preparing": "Подготовка",
    "stage.find": "Поиск видео",
    "stage.download": "Загрузка",
    "stage.downloadVideos": "Загрузка видео",
    "stage.combine": "Объединение",
    "stage.save": "Сохранение",
    "stage.done": "Готово",
    "stage.serverMux": "Скачивание",
    "stage.error": "Что-то пошло не так",
    "step.find": "Поиск",
    "step.download": "Загрузка",
    "step.combine": "Сборка",
    "step.save": "Файл",
    "stat.speed": "Скорость",
    "stat.eta": "Осталось",
    "stat.progress": "Прогресс",
    "advanced.title": "Дополнительно",
    "advanced.filename": "Имя файла",
    "advanced.referer": "Referer",
    "advanced.log": "Лог процесса",
    "foot.privacy": "Без загрузки, без слежки",
    "speed.label": "{rate}/с",
    "speed.idle": "—",
    "eta.idle": "—",
    "eta.seconds": "{s} с",
    "eta.minutes": "{m} мин {s} с",
    "eta.hours": "{h} ч {m} мин",
    "queue.of": "{i} / {n}",
    "lang.toggle": "EN",
    "err.empty": "Вставь ссылку Kinescope, URL страницы или HTML",
    "err.clipboard": "Буфер обмена пуст или нет доступа. Зажми и выбери «Вставить»",
    "err.nothing": "Ничего не выбрано для загрузки",
  },
};

let current = detectLang();

function detectLang() {
  try {
    const stored = localStorage.getItem("kinescrape-lang");
    if (stored && DICTIONARY[stored]) return stored;
  } catch {
    /* localStorage may be blocked */
  }
  const nav = (navigator.language || "en").toLowerCase();
  return nav.startsWith("ru") || nav.startsWith("uk") || nav.startsWith("be") ? "ru" : "en";
}

export function getLang() {
  return current;
}

export function setLang(lang) {
  if (!DICTIONARY[lang]) return;
  current = lang;
  try { localStorage.setItem("kinescrape-lang", lang); } catch { /* ignore */ }
  document.documentElement.lang = lang;
  applyTranslations(document);
}

export function toggleLang() {
  setLang(current === "ru" ? "en" : "ru");
}

export function t(key, vars = {}) {
  const dict = DICTIONARY[current] || DICTIONARY.en;
  let value = dict[key] ?? DICTIONARY.en[key] ?? key;
  for (const [k, v] of Object.entries(vars)) {
    value = value.replace(`{${k}}`, v);
  }
  return value;
}

export function applyTranslations(root = document) {
  for (const node of root.querySelectorAll("[data-i18n]")) {
    node.textContent = t(node.dataset.i18n);
  }
  for (const node of root.querySelectorAll("[data-i18n-placeholder]")) {
    node.placeholder = t(node.dataset.i18nPlaceholder);
  }
  for (const node of root.querySelectorAll("[data-i18n-aria-label]")) {
    node.setAttribute("aria-label", t(node.dataset.i18nAriaLabel));
  }
  for (const node of root.querySelectorAll("[data-i18n-title]")) {
    node.title = t(node.dataset.i18nTitle);
  }
  document.title = t("title");
  document.documentElement.lang = current;
}
