// RU domain bypass list (routed direct via WAN by PBR). Editable data, not device-specific.
const RU_DOMAINS = [
  'ru', 'su', 'xn--p1ai', 'yandex.net', 'vk.com', 'vkontakte.ru', 'sberbank.com', 'gosuslugi.ru',
  'tinkoff.com', 'yandex.com', 'yandex.eu', 'okko.tv', 'more.tv', 'premier.one', 'vkplay.live',
  'mts.ai', 'pochta.online', 'cdek.shopping', 'ozon.tech', 'alfabank.com', 'vtb.com', 'raiffeisen.ru',
  'tbank.ru', 'megafon.tv', 'beeline.tv', 'rostelecom.tv', 'rt.tech',
];

module.exports = { RU_DOMAINS };
