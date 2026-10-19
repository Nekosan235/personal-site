import { createThemeController } from './components/theme.js?v=1.4.0';
import { createAppearanceSettings } from './components/appearance.js?v=1.6.0';

const theme = createThemeController();
const appearance = createAppearanceSettings(theme);
document.body.append(appearance.element);
document.querySelector('#login-appearance').addEventListener('click', appearance.open);

// The login form is a native POST. Do not cancel submit or rewrite the
// fields: browsers save and autofill passwords only after a real navigation.
