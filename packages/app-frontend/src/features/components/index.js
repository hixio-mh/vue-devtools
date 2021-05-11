import { ref, computed, watch } from '@vue/composition-api'
import Vue from 'vue'
import groupBy from 'lodash/groupBy'
import {
  BridgeEvents,
  parse,
  sortByKey,
  searchDeepInObject,
  BridgeSubscriptions,
  isChrome,
  openInEditor
} from '@vue-devtools/shared-utils'
import { getBridge, useBridge } from '@front/features/bridge'
import { putError } from '@front/features/error'
import { useRoute, useRouter } from '@front/util/router'

const rootInstances = ref([])
let componentsMap = {}
let componentsParent = {}
const treeFilter = ref('')
const selectedComponentId = ref(null)
const selectedComponentData = ref(null)
const selectedComponentStateFilter = ref('')
let selectedComponentPendingId = null
let lastSelectedApp = null
let lastSelectedComponentId = null
const expandedMap = ref({})
let resetComponentsQueued = false

export function useComponentRequests () {
  const router = useRouter()

  function selectComponent (id, replace = false) {
    if (selectedComponentId.value !== id) {
      router[replace ? 'replace' : 'push']({
        params: {
          componentId: id
        }
      })
    } else {
      loadComponent(id)
    }
  }

  return {
    requestComponentTree,
    selectComponent
  }
}

export function useComponents () {
  const { onBridge, subscribe } = useBridge()
  const route = useRoute()
  const {
    requestComponentTree,
    selectComponent
  } = useComponentRequests()

  watch(treeFilter, () => {
    requestComponentTree()
  })

  watch(() => route.value.params.componentId, value => {
    selectedComponentId.value = value
    loadComponent(value)
  }, {
    immediate: true
  })

  function subscribeToSelectedData () {
    let unsub
    watch(selectedComponentId, value => {
      if (unsub) {
        unsub()
        unsub = null
      }

      if (value != null) {
        unsub = subscribe(BridgeSubscriptions.SELECTED_COMPONENT_DATA, {
          instanceId: value
        })
      }
    }, {
      immediate: true
    })
  }

  // We watch for the tree data so that we can auto load the current selected component
  watch(() => componentsMap, () => {
    if (selectedComponentId.value && selectedComponentPendingId !== selectedComponentId.value && !selectedComponentData.value) {
      selectComponent(selectedComponentId.value)
    }
  }, {
    immediate: true,
    deep: true
  })

  onBridge(BridgeEvents.TO_FRONT_APP_SELECTED, ({ id }) => {
    requestComponentTree()
    selectedComponentData.value = null
    if (lastSelectedApp !== null) {
      selectLastComponent()
    }
    lastSelectedApp = id
  })

  // Re-select last selected component when switching back to inspector component tab
  function selectLastComponent () {
    if (lastSelectedComponentId) {
      selectComponent(lastSelectedComponentId, true)
    }
  }

  return {
    rootInstances: computed(() => rootInstances.value),
    treeFilter,
    selectedComponentId: computed(() => selectedComponentId.value),
    requestComponentTree,
    selectComponent,
    selectLastComponent,
    subscribeToSelectedData
  }
}

export function useComponent (instance) {
  const { selectComponent, requestComponentTree } = useComponentRequests()
  const { subscribe } = useBridge()

  const isExpanded = computed(() => !!expandedMap.value[instance.value.id])
  const isExpandedUndefined = computed(() => expandedMap.value[instance.value.id] == null)

  function toggleExpand (load = true) {
    if (!instance.value.hasChildren) return
    setComponentOpen(instance.value.id, !isExpanded.value)
    if (load) {
      requestComponentTree(instance.value.id)
    }
  }

  const isSelected = computed(() => selectedComponentId.value === instance.value.id)

  function select () {
    selectComponent(instance.value.id)
  }

  function subscribeToComponentTree () {
    let unsub
    watch(() => instance.value.id, value => {
      if (unsub) {
        unsub()
        unsub = null
      }

      if (value != null) {
        unsub = subscribe(BridgeSubscriptions.COMPONENT_TREE, {
          instanceId: value
        })
      }
    }, {
      immediate: true
    })
  }

  if (isExpanded.value) {
    requestComponentTree(instance.value.id)
  }

  return {
    isExpanded,
    isExpandedUndefined,
    toggleExpand,
    isSelected,
    select,
    subscribeToComponentTree
  }
}

export function setComponentOpen (id, isOpen) {
  Vue.set(expandedMap.value, id, isOpen)
}

export function useSelectedComponent () {
  const data = computed(() => selectedComponentData.value)
  const state = computed(() => selectedComponentData.value ? groupBy(sortByKey(selectedComponentData.value.state.filter(el => {
    return searchDeepInObject({
      [el.key]: el.value
    }, selectedComponentStateFilter.value)
  })), 'type') : ({}))

  const fileIsPath = computed(() => data.value.file && /[/\\]/.test(data.value.file))

  function inspectDOM () {
    if (!data.value) return
    if (isChrome) {
      getBridge().send(BridgeEvents.TO_BACK_COMPONENT_INSPECT_DOM, { instanceId: data.value.id })
    } else {
      window.alert('DOM inspection is not supported in this shell.')
    }
  }

  function openFile () {
    if (!data.value) return
    openInEditor(data.value.file)
  }

  const { bridge } = useBridge()

  function editState (dotPath, payload, type) {
    bridge.send(BridgeEvents.TO_BACK_COMPONENT_EDIT_STATE, {
      instanceId: data.value.id,
      dotPath,
      type,
      ...payload
    })
  }

  return {
    data,
    state,
    stateFilter: selectedComponentStateFilter,
    inspectDOM,
    fileIsPath,
    openFile,
    editState
  }
}

export function resetComponents () {
  resetComponentsQueued = false
  rootInstances.value = []
  componentsMap = {}
  componentsParent = {}
}

export function setupComponentsBridgeEvents (bridge) {
  selectedComponentPendingId = null
  expandedMap.value = {}

  bridge.on(BridgeEvents.TO_FRONT_COMPONENT_TREE, ({ instanceId, treeData, notFound }) => {
    const isRoot = instanceId.endsWith('root')

    // Reset
    if (resetComponentsQueued) {
      resetComponents()
    }

    // Not supported
    if (!treeData) {
      if (isRoot && !notFound) {
        putError('Component tree not supported')
      }
      return
    }

    // Handle tree data
    const data = parse(treeData)
    const instance = componentsMap[instanceId]
    if (instance) {
      for (const item of data) {
        restoreChildrenFromComponentsMap(item)
        const component = updateComponentsMapData(item)
        addToComponentsMap(component)
      }
    } else if (Array.isArray(data)) {
      rootInstances.value = data
      data.forEach(i => addToComponentsMap(i))
    }

    // Try to load selected component again
    if (isRoot && selectedComponentId.value && !selectedComponentData.value && !selectedComponentPendingId) {
      loadComponent(selectedComponentId.value)
    }
  })

  bridge.on(BridgeEvents.TO_FRONT_COMPONENT_SELECTED_DATA, ({ instanceId, data, parentIds }) => {
    if (instanceId === selectedComponentId.value) {
      selectedComponentData.value = parse(data)
    }
    if (instanceId === selectedComponentPendingId) {
      selectedComponentPendingId = null
    }
    if (parentIds) {
      parentIds.reverse().forEach(id => {
        // Ignore root
        if (id.endsWith('root')) return
        setComponentOpen(id, true)
        requestComponentTree(id)
      })
    }
  })

  bridge.on(BridgeEvents.TO_FRONT_COMPONENT_INSPECT_DOM, () => {
    chrome.devtools.inspectedWindow.eval('inspect(window.__VUE_DEVTOOLS_INSPECT_TARGET__)')
  })
}

function requestComponentTree (instanceId = null) {
  if (!instanceId) {
    instanceId = '_root'
  }
  if (instanceId === '_root') {
    resetComponentsQueued = true
  }
  getBridge().send(BridgeEvents.TO_BACK_COMPONENT_TREE, {
    instanceId,
    filter: treeFilter.value
  })
}

function restoreChildrenFromComponentsMap (data) {
  const instance = componentsMap[data.id]
  if (instance && data.hasChildren) {
    if (!data.children.length && instance.children.length) {
      data.children = instance.children
    } else {
      for (const child of data.children) {
        restoreChildrenFromComponentsMap(child)
      }
    }
  }
}

function updateComponentsMapData (data) {
  const component = componentsMap[data.id]
  for (const key in data) {
    Vue.set(component, key, data[key])
  }
  return component
}

function addToComponentsMap (instance) {
  componentsMap[instance.id] = instance
  if (instance.children) {
    instance.children.forEach(c => {
      componentsParent[c.id] = instance.id
      addToComponentsMap(c)
    })
  }
}

function loadComponent (id) {
  if (!id || selectedComponentPendingId === id) return
  lastSelectedComponentId = id
  selectedComponentPendingId = id
  bridge.send(BridgeEvents.TO_BACK_COMPONENT_SELECTED_DATA, id)
}
