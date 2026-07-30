import { createRouter, createWebHistory } from 'vue-router'
import DashboardView from './views/DashboardView.vue'
import ConfigView from './views/ConfigView.vue'
import ToolsView from './views/ToolsView.vue'
import AnalyseView from './views/AnalyseView.vue'
import PlanView from './views/PlanView.vue'
import ObjectivesView from './views/ObjectivesView.vue'
import ObjectiveDetailView from './views/ObjectiveDetailView.vue'
import MemoryView from './views/MemoryView.vue'
import PermissionsView from './views/PermissionsView.vue'

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'dashboard', component: DashboardView },
    { path: '/outils', name: 'outils', component: ToolsView },
    { path: '/config', name: 'config', component: ConfigView },
    { path: '/p/:slug', name: 'objectives', component: ObjectivesView, props: true },
    { path: '/p/:slug/plan', name: 'plan', component: PlanView, props: true },
    { path: '/p/:slug/analyse', name: 'analyse', component: AnalyseView, props: true },
    { path: '/p/:slug/memory', name: 'memory', component: MemoryView, props: true },
    { path: '/p/:slug/permissions', name: 'permissions', component: PermissionsView, props: true },
    { path: '/o/:id', name: 'objective', component: ObjectiveDetailView, props: true },
  ],
})
