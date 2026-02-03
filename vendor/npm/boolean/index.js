"use strict";

/**
 * 将常见值转换为布尔值。
 *
 * 兼容上游 `boolean` 包常用行为：
 * - 字符串：true/t/yes/y/on/1 => true（忽略大小写与首尾空白）
 * - 数字：1 => true
 * - 布尔：原值
 * - 其他：false
 *
 * @param {*} value 任意输入值
 * @returns {boolean} 转换后的布尔值
 */
function boolean(value) {
  switch (Object.prototype.toString.call(value)) {
    case "[object String]": {
      const normalized = value.trim().toLowerCase();
      return ["true", "t", "yes", "y", "on", "1"].includes(normalized);
    }
    case "[object Number]":
      return value.valueOf() === 1;
    case "[object Boolean]":
      return value.valueOf();
    default:
      return false;
  }
}

/**
 * 判断值是否“可被解析”为布尔值（包含 true 与 false 两类可识别输入）。
 *
 * @param {*} value 任意输入值
 * @returns {boolean} 是否可被解析为布尔值
 */
function isBooleanable(value) {
  switch (Object.prototype.toString.call(value)) {
    case "[object String]": {
      const normalized = value.trim().toLowerCase();
      return [
        "true",
        "t",
        "yes",
        "y",
        "on",
        "1",
        "false",
        "f",
        "no",
        "n",
        "off",
        "0",
      ].includes(normalized);
    }
    case "[object Number]":
      return [0, 1].includes(value.valueOf());
    case "[object Boolean]":
      return true;
    default:
      return false;
  }
}

module.exports = {
  boolean,
  isBooleanable,
};

