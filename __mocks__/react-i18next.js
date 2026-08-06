const reactI18next = require('react-i18next');

module.exports = {
  ...reactI18next,
  useTranslation: () => ({
    t: (key, defaultValue, options = {}) => {
      const values = typeof defaultValue === 'object' ? defaultValue : options;
      const template = typeof defaultValue === 'object' ? defaultValue.defaultValue : defaultValue;
      return String(template ?? key).replace(/{{(\w+)}}/g, (match, name) =>
        Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : match,
      );
    },
    i18n: { language: 'en' },
  }),
};
