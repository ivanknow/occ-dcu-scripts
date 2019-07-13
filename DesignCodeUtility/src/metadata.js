"use strict"

const Promise = require("bluebird")
const upath = require("upath")

const classify = require("./classifier").classify
const constants = require("./constants").constants
const endPointTransceiver = require("./endPointTransceiver")
const eTagFor = require("./etags").eTagFor
const exists = require("./utils").exists
const getBasePath = require("./utils").getBasePath
const info = require("./logger").info
const inTransferMode = require("./state").inTransferMode
const PuttingFileType = require("./puttingFileType").PuttingFileType
const readJsonFile = require("./utils").readJsonFile
const splitFromBaseDir = require("./utils").splitFromBaseDir
const walkDirectory = require("./utils").walkDirectory
const warn = require("./logger").warn
const writeFile = require("./utils").writeFile

const cache = {}

/**
 * Load up a bunch of data up front to make things quicker.
 * @return a Bluebird promise.
 */
function initializeMetadata() {

  // Populate the cache in parallel for speed.
  return Promise.all([
    cacheWidgetInstances(),
    cacheWidgetDescriptors(),
    cacheWidgetElements(),
    cacheGlobalElements(),
    cacheStackInstances(),
    cacheStackDescriptors(),
    cacheThemes()
  ])
}

/**
 * Load all themes from the target server into the cache to ensure matching is faster.
 * @returns A BlueBird promise.
 */
function cacheThemes() {

  // Create a theme name to theme map, keyed on name.
  cache.themes = new Map()

  return endPointTransceiver.getThemes("?type=custom").then(
    results => results.data.items.forEach((theme) => cache.themes.set(theme.name, theme)))
}

/**
 * Put the key creation logic for widget instance cache in one (reusable) place.
 * Must match on display name and version as instances can have the same name but different versions.
 * @param displayName
 * @param version
 * @returns {string}
 */
function makeWidgetInstanceKey(displayName, version) {
  return `Display Name: ${displayName} Version: ${version}`
}

/**
 * Load all Widget Instances from the target server into the cache to ensure matching is faster.
 * @returns A BlueBird promise.
 */
function cacheWidgetInstances() {

  // Reduce all the instances to one big array then stick em in a map keyed on display name.
  cache.widgetInstances = new Map()

  // Look for Oracle supplied widgets. In parallel, grab any user created widgets. These will be grouped by type and be the latest version.
  // After we get the current versions, look about for any old ones.
  return Promise.all([
    endPointTransceiver.getAllWidgetInstances("?source=100")
      .then(results => {
        if (results.data.items) {
          results.data.items.forEach(widget => {

            const widgetDesc = JSON.parse(JSON.stringify(widget))
            delete widgetDesc.instances

            widget.instances.forEach(instance => {
              instance.descriptor = widgetDesc

              cache.widgetInstances.set(
                makeWidgetInstanceKey(instance.displayName, instance.version), instance)
            })
          })
        }
      }),
    endPointTransceiver.getAllWidgetInstances("?source=101")
      .then(results => {
        if (results.data.items) {
          results.data.items.forEach(widget => {

            const widgetDesc = JSON.parse(JSON.stringify(widget))
            delete widgetDesc.instances

            widget.instances.forEach(instance => {
              instance.descriptor = widgetDesc

              cache.widgetInstances.set(
                makeWidgetInstanceKey(instance.displayName, instance.version), instance)
            })
          })
        }
      })
  ])
}

/**
 * Load all Widget Descriptors from the target server into the cache to ensure matching is faster.
 * @returns A BlueBird promise.
 */
function cacheWidgetDescriptors() {

  // We don't make this into a map like the others as the matching is more fiddly.
  return endPointTransceiver.getAllWidgetDescriptors().then(results => {
    cache.widgetDescriptors = results.data.items
  })
}

/**
 * Load all Widget Descriptors from the target server into the cache to ensure matching is faster.
 * @returns A BlueBird promise.
 */
function cacheStackDescriptors() {

  // We don't make this into a map like the others as the matching is more fiddly.
  return endPointTransceiver.getAllStackDescriptors().then(results => {
    cache.stackDescriptors = results.data.items
  })
}

/**
 * Load all Global Elements from the target server into the cache to ensure matching is faster.
 * @returns A BlueBird promise.
 */
function cacheGlobalElements() {

  return cacheElements("globalElements", true)
}

/**
 * Load all Widget Elements from the target server into the cache to ensure matching is faster.
 * @returns A BlueBird promise.
 */
function cacheWidgetElements() {
  return cacheElements("widgetElements", false)
}

/**
 * Boilerplate for caching elements.
 * @param field
 * @param globals
 * @return {*|PromiseLike<T>|Promise<T>}
 */
function cacheElements(field, globals) {

  // Create a tag to element map.
  cache[field] = new Map()

  // getElements() is new so don't assume its there.
  if (endPointTransceiver.serverSupports("getElements")) {

    return endPointTransceiver.getElements(`?globals=${globals}`).then(
      results => results.data.items.forEach(element => cache[field].set(element.tag, element)))
  }
}

/**
 * See if an element with the matching tag exists either as a global element or under a widget.
 * @param tag
 * @return {*}
 */
function getElementByTag(tag) {

  const globalElement = cache.globalElements.get(tag)
  return globalElement ? globalElement : cache.widgetElements.get(tag)
}

/**
 * Load all Global Elements from the target server into the cache to ensure matching is faster.
 * @returns A BlueBird promise.
 */
function cacheStackInstances() {

  // Collect all the stack instances together and then store them in a map, keyed on display name.
  cache.stackInstances = new Map()

  return endPointTransceiver.getAllStackInstances().then(
    results => results.data.items.reduce((stackInstances, stack) => stackInstances.concat(stack.instances), [])
      .forEach(stackInstance => cache.stackInstances.set(
        makeWidgetInstanceKey(stackInstance.name, stackInstance.descriptor.version), stackInstance)))
}

/**
 * Get the name of the last node that we grabbed from.
 * @param path - optional path to the file or directory we are using
 * @return value of the last node we grabbed from or null if we can't find it.
 */
function getLastNode(path) {

  // If we have a path to the file or directory we are working with, use that.
  // If we don't have such a path, use the base directory. If we don't have that,
  // use the current working directory.
  const targetFileOrDirectory = path ? path : (getBasePath() ? getBasePath() : ".")

  // Find the base metadata - if we can find it.
  const metadata = readMetadataFromDisk(targetFileOrDirectory, constants.configMetadataJson)

  // Just need the node value.
  return metadata ? metadata.node : null
}

/**
 * Given a path to an asset and a metadata file type, return the path to its associated metadata file.
 * @param path
 * @param type
 * @returns a path
 */
function getMetadataPath(path, type) {

  // Split up the path into two bits and tokenize the subDir for later.
  const splitDirs = splitFromBaseDir(path)
  const baseDir = splitDirs[0], subDir = splitDirs[1]
  const tokens = subDir.split("/")

  // Figure out the rest of the path based on the type of metadata.
  switch (type) {
    case constants.configMetadataJson :
      return `${baseDir}/${constants.trackingDir}/${type}`

    case constants.elementMetadataJson :
    case constants.themeMetadataJson :
      return `${baseDir}/${constants.trackingDir}/${subDir}/${type}`

    case constants.stackMetadataJson:
      const stackBaseDir = tokens.slice(0, tokens.indexOf("stack") + 2).join("/")
      return `${baseDir}/${constants.trackingDir}/${stackBaseDir}/${type}`

    case constants.stackInstanceMetadataJson :
      const stackInstanceBaseDir = tokens.slice(0, tokens.indexOf("instances") + 2).join("/")
      return `${baseDir}/${constants.trackingDir}/${stackInstanceBaseDir}/${type}`

    case constants.widgetMetadataJson :
      const widgetBaseDir = tokens.slice(0, tokens.indexOf("widget") + 2).join("/")
      return `${baseDir}/${constants.trackingDir}/${widgetBaseDir}/${type}`

    case constants.widgetInstanceMetadataJson :
      const widgetInstanceBaseDir = tokens.slice(0, tokens.indexOf("instances") + 2).join("/")
      return `${baseDir}/${constants.trackingDir}/${widgetInstanceBaseDir}/${type}`
  }
}

/**
 * Find the metadata for the matching entity given by path and type on the target server.
 * @param path
 * @param type
 * @returns A BlueBird promise
 */
function readMetadataFromServer(path, type) {

  let metadata

  switch (type) {
    case constants.themeMetadataJson :
      metadata = getMatchingTheme(path)
      break
    case constants.elementMetadataJson :
      metadata = getMatchingElement(path)
      break
    case constants.stackMetadataJson :
      metadata = getMatchingStack(path)
      break
    case constants.stackInstanceMetadataJson :
      metadata = getMatchingStackInstance(path)
      break
    case constants.widgetMetadataJson :
      metadata = getMatchingWidget(path)
      break
    case constants.widgetInstanceMetadataJson :
      metadata = getMatchingWidgetInstance(path)
      break
    case constants.configMetadataJson:
      metadata = readMetadataFromDisk(path, type)
      break
  }

  // Add in the etag too.
  !inTransferMode() && metadata && (metadata.etag = eTagFor(path))

  return metadata
}

/**
 * Read the contents of specified metadata JSON file, leaving the how to this module.
 * @param path - path to the asset we are interested in e.g. widget template - can be relative or absolute.
 * @param type of metadata file we want
 * @returns A BlueBird promise returning the file contents as a JavaScript object graph or null.
 */
const readMetadata = Promise.method(readMetadataFromServer)

/**
 * Handy function to find the widget information in the cache, given a copy of the metadata on disk.
 * @param metadata
 * @returns {V}
 */
function getCachedWidgetInstanceFromMetadata(metadata) {

  if (!metadata)
    return null

  return cache.widgetInstances.get(makeWidgetInstanceKey(metadata.displayName, metadata.version))
}

/**
 * Find the matching widget instance given by path on the target server.
 * @param path
 */
function getMatchingWidgetInstance(path) {

  // Get the metadata for the local file first.
  const widgetInstanceMetadata = readMetadataFromDisk(path, constants.widgetInstanceMetadataJson)

  // See if we can find a widget with instance of the right name and version.
  const matchingWidgetInstance = getCachedWidgetInstanceFromMetadata(widgetInstanceMetadata)

  if (matchingWidgetInstance) {

    info("matchingWidgetInstanceFound", {path})

    const widgetInstanceMetadata = {
      repositoryId: matchingWidgetInstance.repositoryId,
      descriptorRepositoryId: matchingWidgetInstance.descriptor.repositoryId,
      version: matchingWidgetInstance.version,
      displayName: matchingWidgetInstance.displayName
    }

    // Need extra fields for elementized widgets.
    if (matchingWidgetInstance.currentLayout) {
      widgetInstanceMetadata.layoutInstanceId = matchingWidgetInstance.currentLayout.repositoryId
      widgetInstanceMetadata.layoutDescriptorId = matchingWidgetInstance.currentLayout.widgetLayoutDescriptor.repositoryId
    } else {

      // currentLayout may not be set yet as it is only set after the first update. Look in the widget descriptor too.
      const widgetMetadata = readMetadataFromDisk(path, constants.widgetMetadataJson)

      // Try to at least get the layout descriptor ID.
      if (widgetMetadata.elementized) {

        const matchingWidget = cache.widgetDescriptors.find(
          widget => widget.version === widgetMetadata.version && widget.displayName === widgetMetadata.displayName)

        widgetInstanceMetadata.layoutDescriptorId = matchingWidget.layouts[0].repositoryId
      }
    }

    return widgetInstanceMetadata
  } else {

    warn("noMatchingWidgetInstanceFound", {path})
    return null
  }
}

/**
 * Find the match for the widget on the remote system given by path.
 * @param path
 */
function getMatchingWidget(path) {

  // Get the metadata for the local file first.
  const metadata = readMetadataFromDisk(path, constants.widgetMetadataJson)

  // See if we can find a widget with the same name same name and version.
  const matchingWidget = cache.widgetDescriptors.find(
    widget => widget.version === metadata.version && widget.displayName === metadata.displayName)

  if (matchingWidget) {

    info("matchingWidgetFound", {path})
    return {
      repositoryId: matchingWidget.repositoryId,
      widgetType: matchingWidget.widgetType,
      elementized: !!matchingWidget.layouts.length
    }

  } else {

    warn("noMatchingWidgetFound", {path})
    return null
  }
}

/**
 * Handy function to find the stack information in the cache, given a copy of the metadata on disk.
 * @param metadata
 * @returns {V}
 */
function getCachedStackInstanceFromMetadata(metadata) {
  return cache.stackInstances.get(makeWidgetInstanceKey(metadata.name, metadata.version))
}

/**
 * Find the match for the stack instance on the remote system given by path.
 * @param path
 */
function getMatchingStack(path) {

  // Get metadata from the tracking dir.
  const metadata = readMetadataFromDisk(path, constants.stackMetadataJson)

  // See if we can find a stack with the same name same name and version.
  const matchingStack = cache.stackDescriptors.find(
    stack => stack.version === metadata.version && stack.displayName === metadata.displayName)

  if (matchingStack) {

    info("matchingStackFound", {path})
    return {
      repositoryId: matchingStack.repositoryId,
      stackType: matchingStack.stackType,
    }
  } else {

    warn("noMatchingStackFound", {path})
    return null
  }
}

/**
 * Find the match for the stack instance on the remote system given by path.
 * @param path
 */
function getMatchingStackInstance(path) {

  // Get metadata from the tracking dir.
  const metadata = readMetadataFromDisk(path, constants.stackInstanceMetadataJson)

  // Walk through all stack instances of all stacks looking for a matching name.
  const matchingStackInstance = getCachedStackInstanceFromMetadata(metadata)

  // See what we got.
  if (matchingStackInstance) {

    info("matchingStackInstanceFound", {path})
    return {
      repositoryId: matchingStackInstance.repositoryId,
      version: metadata.version,
      displayName: matchingStackInstance.displayName
    }
  } else {

    warn("noMatchingStackInstanceFound", {path})
    return null
  }
}

/**
 * Ensure that the given element file has a counterpart on the remote machine.
 * @param path
 */
function getMatchingElement(path) {

  // Get the metadata from the tracking dir first.
  const elementMetadata = readMetadataFromDisk(path, constants.elementMetadataJson)

  // See if its a global or under a widget...
  const fileType = classify(path)
  if (fileType === PuttingFileType.GLOBAL_ELEMENT_TEMPLATE ||
    fileType === PuttingFileType.GLOBAL_ELEMENT_JAVASCRIPT ||
    fileType === PuttingFileType.GLOBAL_ELEMENT_METADATA) {

    // See if we can find it in the cache.
    const matchingElement = cache.globalElements.get(elementMetadata.tag)

    if (matchingElement) {

      // Tell the user we found a match in transfer mode.
      inTransferMode() && info("matchingElementFound", {path})
      return elementMetadata
    } else {

      warn("noMatchingElementFound", {path})
      return null
    }
  } else {

    // Need to know about the widget.
    const widgetMetadata = readMetadataFromDisk(path, constants.widgetMetadataJson)

    // Element is under a widget - look for a widget of the same name and version, which will contain the element.
    const matchingWidget = cache.widgetDescriptors.find(
      widget => widget.version === elementMetadata.version && widget.widgetType === widgetMetadata.widgetType)

    if (matchingWidget) {

      // Tell the user we found a match in transfer mode.
      inTransferMode() && info("matchingElementFound", {path})

      return {tag: elementMetadata.tag, widgetId: matchingWidget.repositoryId}
    } else {

      warn("noMatchingElementFound", {path})
      return null
    }
  }
}

/**
 * Look on the target server for a matching theme.
 * @param path
 * @returns A BlueBird promise
 */
function getMatchingTheme(path) {

  // Get the metadata for the local file first.
  const metadata = readMetadataFromDisk(path, constants.themeMetadataJson)

  // See if we can find a theme on the target server with the same name.
  const matchingTheme = cache.themes.get(metadata.displayName)

  if (matchingTheme) {

    // Only tell the user we found a match in transfer mode.
    inTransferMode() && info("matchingThemeFound", {name: metadata.displayName})

    return {
      repositoryId: matchingTheme.repositoryId
    }
  } else {
    warn("noMatchingThemeFound", {name: metadata.displayName})
    return null
  }
}

/**
 * Return true if the theme for the given file exists on the target server.
 * This method will only work in transfer mode as this is the only time that themes will not necessarily exist.
 * @param path
 */
function themeExistsOnTarget(path) {

  // Get the metadata for the local file first.
  const metadata = readMetadataFromDisk(path, constants.themeMetadataJson)

  return cache.themes.get(metadata.displayName)
}

/**
 * Return true if the widget exists on the target instance - this will work in transfer and non transfer mode.
 * @param path
 */
function widgetExistsOnTarget(path) {

  // Get the metadata for the local file first.
  const metadata = readMetadataFromDisk(path, constants.widgetMetadataJson)

  // If it exists on the target, widget should already exist in the cache.
  return cache.widgetDescriptors.find(widget =>
    widget.version === metadata.version && widget.widgetType === metadata.widgetType)
}

/**
 * Return true if the widget exists on the target instance - this will work in transfer and non transfer mode.
 * @param path
 */
function stackExistsOnTarget(path) {

  // Get the metadata for the local file first.
  const metadata = readMetadataFromDisk(path, constants.stackMetadataJson)

  // If it exists on the target, stack should already exist in the cache.
  return cache.stackDescriptors.find(stack =>
    stack.version === metadata.version && stack.displayName === metadata.displayName)
}

/**
 * Return true if the element exists on the target instance - this will work in transfer and non transfer mode.
 * @param path
 */
function elementExistsOnTarget(path) {

  // Get the metadata for the local file first.
  const metadata = readMetadataFromDisk(path, constants.elementMetadataJson)

  // If it exists on the target, element should already exist in the cache.
  return cache.globalElements.get(metadata.tag)
}

/**
 * Try to get the metadata for the resource given by path and the metadata type.
 * @param path
 * @param type
 * @param excludeEtag
 * @returns the metadata or null
 */
function readMetadataFromDisk(path, type, excludeEtag) {

  // Figure out where the metadata ought to be.
  const metadataPath = getMetadataPath(path, type)


  // See if it exists.
  if (exists(metadataPath)) {

    const json = readJsonFile(metadataPath)

    // Add in the etag too.
    !excludeEtag && (json.etag = eTagFor(path))

    return json
  } else {

    // Can't find the metadata.
    return null
  }
}

/**
 * Write the supplied content to the metadata file.
 * @param path - relative path within the tracking directory
 * @param content
 */
function writeMetadata(path, content) {
  writeFile(`${constants.trackingDir}/${path}`, JSON.stringify(content, null, 2) + "\n")
}

/**
 * Return true if the widget type is already used in the metadata.
 * @param widgetType
 */
function widgetTypeExists(widgetType) {

  // Set up a default return value.
  let exists = false

  // Need to check the metadata on disk.
  walkDirectory(upath.join(constants.trackingDir, constants.widgetsDir), {
    listeners: {
      file: (root, fileStat, next) => {

        // Only interested in widget.jsons.
        if (fileStat.name === constants.widgetMetadataJson &&
          readJsonFile(upath.join(root, fileStat.name)).widgetType === widgetType) {
          exists = true
        }

        // Jump to the next file if we haven't found a match.
        !exists && next()
      }
    }
  })

  return exists
}

/**
 * Return true if the widget type is already used in the metadata.
 */
function stackTypeExists(stackType) {

  // Set up a default return value.
  let exists = false

  // Need to check the metadata on disk.
  walkDirectory(upath.join(constants.trackingDir, constants.stacksDir), {
    listeners: {
      file: (root, fileStat, next) => {

        // Only interested in widget.jsons.
        if (fileStat.name === constants.stackMetadataJson &&
          readJsonFile(upath.join(root, fileStat.name)).stackType === stackType) {
          exists = true
        }

        // Jump to the next file if we haven't found a match.
        if (!exists) next()
      }
    }
  })

  return exists
}

/**
 * Update the supplied metadata.
 * @param path
 * @param type
 * @param additionalMetadata
 */
function updateMetadata(path, type, additionalMetadata) {

  // Load existing metadata sans etag.
  const existingMetadata = readMetadataFromDisk(path, type, true)

  // Stick the new values on top of it.
  Object.keys(additionalMetadata).forEach(key => {
    existingMetadata[key] = additionalMetadata[key]
  })

  // Write out updated metadata.
  writeFile(getMetadataPath(path, type), JSON.stringify(existingMetadata, null, 2))
}

/**
 * Walk through the metadata looking for an element with the same tag.
 * @param searchDir
 * @param tag
 * @returns {boolean}
 */
function tagExistsIn(searchDir, tag) {

  let exists = false

  walkDirectory(upath.join(constants.trackingDir, searchDir), {
    listeners: {
      file: (root, fileStat, next) => {

        // Only interested in element.jsons.
        if (fileStat.name == constants.elementMetadataJson &&
          readJsonFile(upath.join(root, fileStat.name)).tag == tag) {
          exists = true
        }

        // Jump to the next file if we haven't found a match.
        !exists && next()
      }
    }
  })

  return exists
}

/**
 * Return true if an element with the given tag already exists.
 * @param tag
 * @param widgetDir
 */
function elementTagExists(tag) {

  // Must not exist either under any widget or as global element.
  return tagExistsIn(constants.elementsDir, tag) || tagExistsIn(constants.widgetsDir, tag)
}

/**
 * Return true if the element given by path is elementized.
 * @param path
 */
function widgetIsElementized(path) {

  return readMetadataFromDisk(path, constants.widgetMetadataJson).elementized
}

/**
 * Return true if the widget instance exists on the target - this will work in transfer and non transfer mode.
 * @param path
 */
function widgetInstanceExistsOnTarget(path) {

  // Get the metadata for the local file first.
  const metadata = readMetadataFromDisk(path, constants.widgetInstanceMetadataJson)

  // If it exists on the target, instance should already exist in the cache.
  return getCachedWidgetInstanceFromMetadata(metadata)
}

exports.cacheGlobalElements = cacheGlobalElements
exports.cacheThemes = cacheThemes
exports.cacheWidgetDescriptors = cacheWidgetDescriptors
exports.cacheWidgetElements = cacheWidgetElements
exports.cacheWidgetInstances = cacheWidgetInstances
exports.elementExistsOnTarget = elementExistsOnTarget
exports.elementTagExists = elementTagExists
exports.getCachedWidgetInstanceFromMetadata = getCachedWidgetInstanceFromMetadata
exports.getElementByTag = getElementByTag
exports.cacheStackDescriptors = cacheStackDescriptors
exports.cacheStackInstances = cacheStackInstances
exports.getCachedWidgetInstanceFromMetadata = getCachedWidgetInstanceFromMetadata
exports.getCachedStackInstanceFromMetadata = getCachedStackInstanceFromMetadata
exports.getLastNode = getLastNode
exports.initializeMetadata = initializeMetadata
exports.readMetadata = readMetadata
exports.readMetadataFromDisk = readMetadataFromDisk
exports.themeExistsOnTarget = themeExistsOnTarget
exports.updateMetadata = updateMetadata
exports.widgetExistsOnTarget = widgetExistsOnTarget
exports.widgetInstanceExistsOnTarget = widgetInstanceExistsOnTarget
exports.widgetIsElementized = widgetIsElementized
exports.widgetTypeExists = widgetTypeExists
exports.writeMetadata = writeMetadata
exports.stackExistsOnTarget = stackExistsOnTarget
exports.widgetTypeExists = widgetTypeExists
exports.stackTypeExists = stackTypeExists
exports.writeMetadata = writeMetadata
