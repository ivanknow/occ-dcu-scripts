#!/bin/bash

# load config file
. ./dcu.conf

# read arguments
for i in "$@"
do
case $i in
    -f=*|--file=*)
        file="${i#*=}"
        shift
    ;;
esac
done

# validate arguments
invalid_param="The following parameters are required:\n--file=src/env/path"
[ -z "$file" ] && echo -e $invalid_param && exit 0

# define the environment
if [[ $file == *"/test/"* ]]; then
  env="test"
fi

if [[ $file == *"/stage/"* ]]; then
  env="stage"
fi

if [[ $file == *"/prod/"* ]]; then
  env="prod"
fi

echo -e "Updating file \e[92m$file\e[0m in environment \e[92m$env\e[0m..."

case $env in
    "test")
        dcu -t "$file" -n https://ccadmin-test-$ENVIRONMENT_ID.oracleoutsourcing.com -b src/test -k $TEST_APP_KEY
    ;;
    "stage")
        dcu -t "$file" -n https://ccadmin-stage-$ENVIRONMENT_ID.oracleoutsourcing.com -b src/stage -k $STAGE_APP_KEY
    ;;
    "prod")
        dcu -t "$file" -n https://ccadmin-prod-$ENVIRONMENT_ID.oracleoutsourcing.com -b src/prod -k $PROD_APP_KEY
    ;;
esac
