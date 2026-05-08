/**
 * AI Sidebar
 *
 * The right-side panel hosting the local-AI chat surface. Empty-state shell
 * for now; the install wizard, chat view, and session list land in later
 * steps. Mutual exclusion with the wallet sidebar is handled inside the
 * shared controller.
 */

import { createSidebarController } from './sidebar-controller.js';

const controller = createSidebarController({
  id: 'ai-sidebar',
  toggleBtnId: 'ai-toggle-btn',
  closeBtnId: 'ai-sidebar-close',
  featureFlagKey: 'enableLocalAI',
  keybindingKey: 'A',
  name: 'ai',
});

export const initAiSidebar = controller.init;
export const toggleAiSidebar = controller.toggle;
export const openAiSidebar = controller.open;
export const closeAiSidebar = controller.close;
export const isAiSidebarVisible = controller.isVisible;
export const isAiSidebarFeatureEnabled = controller.isFeatureEnabled;
