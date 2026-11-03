import { createApp } from 'vue';
import App from './App.vue';
import { dialog } from './directives/dialog';
import './styles.css';
import './styles/refinements.css';
import './styles/spaces.css';
import './styles/workbench.css';
createApp(App).directive('dialog', dialog).mount('#app');
