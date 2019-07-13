#!/bin/bash

if [ ! -f dcu.conf ]
then
    touch dcu.conf
fi

conf="dcu.conf"

read -p $'(Required) Enter your OCC ID https://ccadmin-test-XXXX.oracleoutsourcing.com: '  ENVIRONMENT_ID
read -p $'(Optional) Enter your \e[92mtest\e[0m environment app key: '  TEST_APP_KEY
read -p $'(Optional) Enter your \e[92mstage\e[0m environment app key: '  STAGE_APP_KEY
read -p $'(Optional) Enter your \e[92mprod\e[0m environment app key: '  PROD_APP_KEY

echo "You can reconfigure you application keys later in dcu.conf"

typeset -p ENVIRONMENT_ID TEST_APP_KEY STAGE_APP_KEY PROD_APP_KEY > "$conf"

cd DesignCodeUtility
echo "Installing DCU..."
npm install -g

cd ..
