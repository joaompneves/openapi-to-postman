const { isRemoteRef, removeLocalReferenceFromPath } = require('./jsonPointer'),
  { fetchURLs } = require('./fetchContentFile'),
  { DFS } = require('./dfs'),
  parse = require('./parse.js'),
  traverseUtility = require('traverse'),
  _ = require('lodash');


/**
 * verifies if the path has been added to the result
 * @param {string} path - path to find
 * @param {Array} referencesInNode - Array with the already added paths
 * @returns {boolean} - wheter a node with the same path has been added
 */
function added(path, referencesInNode) {
  return referencesInNode.find((reference) => { return reference.path === path; }) !== undefined;
}

/**
 * Gets all the $refs from an object
 * @param {object} currentNode - current node in process
 * @param {Function} refTypeResolver - function to resolve the ref according to type (local, external, web etc)
 * @param {Function} pathSolver - function to resolve the Path
 * @returns {object} - {path : $ref value}
 */
function getReferences (currentNode, refTypeResolver, pathSolver) {
  let referencesInNode = [];
  traverseUtility(currentNode).forEach((property) => {
    if (property) {
      let hasReferenceTypeKey;
      hasReferenceTypeKey = Object.keys(property)
        .find(
          (key) => {
            return refTypeResolver(property, key);
          }
        );
      if (hasReferenceTypeKey) {
        if (!added(property.$ref, referencesInNode)) {
          referencesInNode.push({ path: pathSolver(property) });
        }
      }
    }
  });
  return referencesInNode;
}

/**
 * Downloads the content of the references
 * @param {array} urls The arguments that will be resolved
 * @param {string} origin process location (broser or node)
 * @param {Function} remoteRefsResolver User defined function used to fetch
 * @returns {array} The list of arguments after have been resolved
 */
async function resolveFileRemoteReferences(urls, origin, remoteRefsResolver) {
  const rawURLs = urls.map((item) => { return item.path; }),
    set = new Set(rawURLs);
  return fetchURLs([...set], origin, remoteRefsResolver);
}


/**
   *Maps a url into a local path string
   * @param {string} urlToMap - url to map
   * @returns {string} - path
   */
function mapToLocalPath(urlToMap) {
  return urlToMap;
}

/**
   * Gets all the $refs from an object
   * @param {object} currentNode - current node in process
   * @param {Function} refTypeResolver - function to resolve the ref according to type (local, external, web etc)
   * @returns {undefined} - nothing
*/
function mapReferenceInNode (currentNode, refTypeResolver) {
  traverseUtility(currentNode).forEach((property) => {
    if (property) {
      let hasReferenceTypeKey;
      hasReferenceTypeKey = Object.keys(property)
        .find(
          (key) => {
            return refTypeResolver(property, key);
          }
        );
      if (hasReferenceTypeKey) {
        property.$ref = mapToLocalPath(property.$ref);
      }
    }
  });
}

/**
 * Separate adjacent nodes to the current file and the missing ones
 * if there was an error downloading the content or the response was different to 200
 * is considered missing
 * @param {array} downloadedNodes list of downloaded files { fileName, content}
 * @returns {object} The missing and found files { graphAdj, missingNodes }
 */
function mapToAdjAndMissingResult(downloadedNodes) {
  let missingNodes = [],
    graphAdj = [];

  downloadedNodes.forEach((item) => {
    if (_.isNil(item.content) || item.content.startsWith('NF')) {
      missingNodes.push(item);
    }
    else {
      let mappedPath = mapToLocalPath(item.fileName);
      item.url = item.fileName;
      item.fileName = mappedPath;
      graphAdj.push(item);
    }
  });
  return { graphAdj, missingNodes };
}

/**
   * Gets the adjacent and missing nodes of the current node in the traversal
   * @param {object} currentNode - current { fileName, content} object
   * @param {object} downloaded already downloaded files
   * @param {string} origin process location (broser or node)
   * @param {Function} remoteRefsResolver User defined function used to fetch
   * @returns {object} - Detect root files result object
   */
async function getAdjacentAndMissing (currentNode, downloaded, origin, remoteRefsResolver) {
  let currentNodeReferences,
    downloadedNodes = [],
    nodesFromCache = [],
    toDownload = [],
    OASObject;
  if (currentNode.parsed) {
    OASObject = currentNode.parsed.oasObject;
  }
  else {
    OASObject = parse.getOasObject(currentNode.content);
  }
  currentNodeReferences = getReferences(OASObject, isRemoteRef, removeLocalReferenceFromPath);

  if (currentNodeReferences.length === 0) {
    currentNode.parsed = OASObject;
    return {
      graphAdj: [
      ],
      missingNodes: [
      ]
    };
  }
  currentNodeReferences.forEach((ref) => {
    if (downloaded[ref.path] !== undefined) {
      nodesFromCache.push({ fileName: ref.path, content: downloaded[ref.path] });
    }
    else {
      toDownload.push(ref);
    }
  });
  downloadedNodes = await resolveFileRemoteReferences(toDownload, origin, remoteRefsResolver);
  downloadedNodes.push(...nodesFromCache);
  downloadedNodes.forEach((downloadedItem) => {
    downloaded[downloadedItem.fileName] = downloadedItem.content;
  });
  mapReferenceInNode(OASObject, isRemoteRef);
  currentNode.parsed = OASObject;
  return mapToAdjAndMissingResult(downloadedNodes);
}

/**
   * Validates the input of the remote ref solver
   * Throws error
   * @param {object} specRoot - root file information
   * @param {boolean} batch - wheter is a batch validation
   * @returns {undefined} -
   */
function validateInputGetRemoteReferences(specRoot, batch = false) {
  if (_.isNil(specRoot) || _.isEmpty(specRoot)) {
    if (batch) {
      return false;
    }
    throw new Error('Root file must be defined');
  }
  return true;
}

/**
 * Find and downloads the remote references from the specRoot
 * @param {object} specRoot - root file information
 * @param {string} origin process location (broser or node)
 * @param {Function} remoteRefsResolver User defined function used to fetch
 * @returns {object} - Remote references result object
 */
async function getRemoteReferences(specRoot, origin, remoteRefsResolver) {
  validateInputGetRemoteReferences(specRoot);
  let algorithm = new DFS(),
    downloaded = {},
    { traverseOrder, missing } =
      await algorithm.traverseAsync(specRoot, async (currentNode) => {
        return await getAdjacentAndMissing(currentNode, downloaded, origin, remoteRefsResolver);
      }),
    outputRemoteFiles = traverseOrder.slice(1).map((relatedFile) => {
      return {
        fileName: relatedFile.fileName,
        content: relatedFile.content,
        parsed: relatedFile.parsed
      };
    });
  return { remoteRefs: outputRemoteFiles, missingRemoteRefs: missing, specRoot };
}

/**
 * Find and downloads the remote references from the specRoot
 * @param {array} specRoots - root file information
 * @param {string} origin process location (broser or node)
 * @param {Function} remoteRefsResolver User defined function used to fetch
 * @returns {object} - Remote references result object
 */
async function getRemoteReferencesArray(specRoots, origin, remoteRefsResolver) {
  if (_.isNil(specRoots) || _.isEmpty(specRoots)) {
    return [];
  }
  let cleanRoots = specRoots.filter((root) => {
      let isValid = validateInputGetRemoteReferences(root, true);
      return isValid;
    }),
    result = [];

  for (let index = 0; index < cleanRoots.length; index++) {
    let res = await getRemoteReferences(cleanRoots[index], origin, remoteRefsResolver);
    result.push(res);
  }
  return result;
}


module.exports = {
  getAdjacentAndMissing,
  getRemoteReferences,
  getRemoteReferencesArray
};