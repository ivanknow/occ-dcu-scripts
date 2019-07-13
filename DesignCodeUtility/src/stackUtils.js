"use strict"

/**
 * Get the actual name of a stack instance depending on whether the current
 * name looks like a repository ID or whatever. Who knows? We were doing this
 * in a bunch of places so here it is as a utility function. Also depends a
 * bit on what the repository data looks like so bets are off.
 *
 * @param {object} stackInstance Stack instance metadata object.
 * @return {string} Friendlier stack instance name maybe.
 */
function friendlyStackInstanceName (stackInstance) {
  return (!stackInstance.name || stackInstance.name === stackInstance.repositoryId)
    ? stackInstance.displayName
    : stackInstance.name
}

exports.friendlyStackInstanceName = friendlyStackInstanceName
