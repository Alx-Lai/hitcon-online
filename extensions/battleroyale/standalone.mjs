// Copyright 2021 HITCON Online Contributors
// SPDX-License-Identifier: BSD-2-Clause

import {MapCoord} from '../../common/maplib/map.mjs';
import {LAYER_BULLET, LAYER_OBSTACLE, LAYER_FIRE, BULLET_COOLDOWN} from './common/client.mjs';
import CellSet from '../../common/maplib/cellset.mjs';

const BULLET_SPEED = 100; // ms per block (lower -> quicker)
const BULLET_LIFE = 5; // five blocks
const MAP_UPDATE_PERIOD = 20000; // ms per update

const Facing2Direction = {
  'U': [0, 1],
  'D': [0, -1],
  'R': [1, 0],
  'L': [-1, 0],
};

/**
 * This represents the standalone extension service for this extension.
 */
class Standalone {
  /**
   * Create the standalone extension service object but does not start it.
   * @constructor
   * @param {ExtensionHelper} helper - An extension helper object for servicing
   * various functionalities of the extension.
   */
  constructor(helper) {
    this.helper = helper;
  }

  /**
   * Initializes the extension.
   */
  async initialize() {
    // get the default arena of every map
    this.arenaOfMaps = this.helper.gameMap.getOriginalCellSetStartWith('battleroyaleArena');
    this.obstaclesOfMaps = this.helper.gameMap.getOriginalCellSetStartWith('battleroyaleObstacles');

    this.bullets = new Map(); // key: bullet ID; value: bullet info
    this.bulletID = 0;

    this.fires = new Set();

    for (const mapName of this.arenaOfMaps.keys()) {
      await this.helper.broadcastCellSetUpdateToAllUser(
          'set',
          mapName,
          CellSet.fromObject({
            name: LAYER_BULLET.layerName,
            priority: LAYER_BULLET.zIndex,
            cells: Array.from(this.bullets.values()),
            layers: {[LAYER_BULLET.layerName]: 'BB'},
            dynamic: true,
          }),
      );
      await this.helper.broadcastCellSetUpdateToAllUser(
          'set',
          mapName,
          CellSet.fromObject({
            name: LAYER_FIRE.layerName,
            priority: LAYER_FIRE.zIndex,
            cells: Array.from(this.bullets.values()),
            layers: {[LAYER_FIRE.layerName]: 'BF'},
            dynamic: true,
          }),
      );
    }

    this.cooldown = new Set();
    this.fireCounter = 0;
    const updateMap = setInterval( async () => {
      this.fireCounter++;
      this.fires.clear();
      for (const mapName of this.arenaOfMaps.keys()) {
        const needUpdate = this.updateEdge(
            this.fires, this.arenaOfMaps.get(mapName), this.fireCounter,
        );
        if (!needUpdate) {
          clearInterval(updateMap);
          return;
        }
        await this.helper.broadcastCellSetUpdateToAllUser(
            'update',
            mapName,
            CellSet.fromObject({
              name: LAYER_FIRE.layerName,
              cells: Array.from(this.fires),
            }),
        );
        const players = this.helper.gameState.getPlayers();
        players.forEach((player, playerID) => {
          if (this.helper.gameMap.getCell(player.mapCoord, LAYER_FIRE.layerName)) {
            this.teleport(player.mapCoord, playerID);
          }
        });
      }
    }, MAP_UPDATE_PERIOD);

    await this.helper.gameState.registerOnPlayerUpdate((msg) => {
      try {
        this.onPlayerUpdate(msg);
      } catch (e) {
        console.error('battleroyale register player update listener failed: ', e, e.stack);
      }
    });
  }

  /**
   * Given a Coordinate, return inside battleroyale arena or not
   * @param {MapCoord} cellCoord - The cell position.
   * @return {Boolean} inside or not
   */
  insideMap(cellCoord) {
    for (const {cells} of this.arenaOfMaps.get(cellCoord.mapName)) {
      for (const cell of cells) {
        const width = cell.w ?? 1;
        const height = cell.h ?? 1;
        if (cell.x <= cellCoord.x && cellCoord.x < cell.x + width &&
          cell.y <= cellCoord.y && cellCoord.y < cell.y + height) {
          return true;
        }
      }
    }
    return false;
  }

  /**
   * Client tries to place a bomb at mapCoord.
   * The server returns true on success.
   * @param {Object} player - (TODO: needs docs)
   * @param {MapCoord} mapCoord - The bullet position.
   * @param {String} facing - The bullet facing.
   * @return {Boolean} success or not
   */
  async c2s_attack(player, mapCoord, facing) {
    mapCoord = MapCoord.fromObject(mapCoord);
    // mapCoord has to be inside an arena
    // TODO: use the utility function in maplib if there is such function
    const inside = this.insideMap(mapCoord);
    if (!inside) return;

    if (this.cooldown.has(player.playerID)) return;
    this.cooldown.add(player.playerID);
    setTimeout(() => {
      this.cooldown.delete(player.playerID);
    }, BULLET_COOLDOWN);

    // create bullet
    const bulletID = this.bulletID++;
    const bulletCoord = mapCoord.copy();
    bulletCoord.x += Facing2Direction[facing][0];
    bulletCoord.y += Facing2Direction[facing][1];
    this.bullets.set(bulletID, {facing, bulletCoord, duration: 0});

    // render
    await this.helper.broadcastCellSetUpdateToAllUser(
        'update',
        mapCoord.mapName,
        CellSet.fromObject({
          name: LAYER_BULLET.layerName,
          cells: Array.from(
              this.bullets,
              ([_, v]) => v['bulletCoord'],
          ),
        }),
    );

    // setInterval to update bullet
    const updateBullet = setInterval(async (bulletID) => {
      const bullet = this.bullets.get(bulletID);
      bullet.bulletCoord.x += Facing2Direction[bullet.facing][0];
      bullet.bulletCoord.y += Facing2Direction[bullet.facing][1];
      bullet.duration += 1;
      if (bullet.duration >= BULLET_LIFE ||
          !this.insideMap(bullet.bulletCoord) ||
          this.helper.gameMap.getCell(bullet.bulletCoord, LAYER_OBSTACLE.layerName)) {
        clearInterval(updateBullet);
        this.bullets.delete(bulletID);
        await this.helper.broadcastCellSetUpdateToAllUser(
            'update',
            mapCoord.mapName,
            CellSet.fromObject({
              name: LAYER_BULLET.layerName,
              cells: Array.from(
                  this.bullets,
                  ([_, v]) => v['bulletCoord'],
              ),
            }),
        );
      } else {
        const players = this.helper.gameState.getPlayers();
        players.forEach((player, playerID) => {
          for (const [bulletID, bullet] of this.bullets) {
            if (player.mapCoord.x == bullet.bulletCoord.x &&
              player.mapCoord.y == bulletCoord.y) {
              this.teleport(player.mapCoord, playerID);
              clearInterval(updateBullet); // haven't check if clear interval clear all
              this.bullets.delete(bulletID);
              break;
            }
          }
        });
        await this.helper.broadcastCellSetUpdateToAllUser(
            'update',
            mapCoord.mapName,
            CellSet.fromObject({
              name: LAYER_BULLET.layerName,
              cells: Array.from(
                  this.bullets,
                  ([_, v]) => v['bulletCoord'],
              ),
            }),
        );
      }
    }, BULLET_SPEED, bulletID);


    return true;
  }
  /**
   * Given a gameMap return all edge
   * @param {Set} fires the fire Set
   * @param {Map} cellSets the maps
   * @param {Number} fireCounter count edge width
   * @return {Boolean} need update or not
   */
  updateEdge(fires, cellSets, fireCounter) {
    let noUpdateCounter = 0; let totalCell = 0;
    for (const {cells} of cellSets) {
      for (const {x, y, w, h} of cells) {
        const wbound = Math.min(fireCounter, Math.floor(w/2));
        const hbound = Math.min(fireCounter, Math.floor(h/2));
        totalCell++;
        if (wbound === Math.floor(w/2) && hbound === Math.floor(h/2)) {
          noUpdateCounter++;
        }
        fires.add({x, y, w, h: hbound});
        fires.add({x, y: y+h-hbound, w, h: hbound});
        fires.add({x, y, w: wbound, h});
        fires.add({x: x+w-wbound, y, w: wbound, h});
      }
    }
    return noUpdateCounter != totalCell;
  }

  /**
   *
   * @param {Object} msg
   * @return {undefined}
   */
  async onPlayerUpdate(msg) {
    const {mapCoord, playerID} = msg;

    if (typeof playerID !== 'string') {
      console.warn('Invalid PlayerSyncMessage with non-string msg.playerID', msg, msg.playerID);
      return;
    }
    if (mapCoord === 'undefined') {
      // No location? Just skip.
      return;
    }

    const bullets = this.helper.gameMap.getCell(mapCoord, LAYER_BULLET.layerName);
    if (bullets) {
      this.teleport(mapCoord, playerID);
      return;
    }

    const fire = this.helper.gameMap.getCell(mapCoord, LAYER_FIRE.layerName);
    if (fire) {
      this.teleport(mapCoord, playerID);
      return;
    }

    return;
  }

  /**
   *
   * @param {MapCoord} mapCoord
   * @param {String} playerID
   * @return {undefined}
   */
  teleport(mapCoord, playerID) {
    const target = mapCoord.copy();
    target.x = 1;
    target.y = 1;
    this.helper.teleport(playerID, target, true);
  }
}

export default Standalone;
